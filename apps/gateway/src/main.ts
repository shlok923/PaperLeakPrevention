import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import {
  allocationProof,
  allocationTree,
  bundleHash,
  chainInfoFromConfig,
  examRegistryAbi,
  httpBeaconSource,
  loadEligible,
  merkleRoot,
  readSnapshot,
  receiptCode,
  responseLeaf,
  rosterEntryHash,
  sameAddress,
  send,
  sheetHash,
  signatureToEip2537,
  signerOf,
  signHash,
  storeClient,
  type Allocation,
  type Bundle,
  type EligibleQuestion,
  type ExamInfo,
  type Hex,
  type LogEntry,
  type RosterEntry,
  type SignedSheet,
  type Snapshot,
} from "@eplp/protocol";
import { connect, env, envInt, every, log, openDb, serve, waitForExam, writeJsonFile } from "@eplp/node-kit";

/**
 * The center gateway. It runs the hall network: mirrors ciphertext, relays drand,
 * signs check-ins, forwards terminal requests to custodians, keeps answer backups,
 * and posts the center's one transaction per shift. It never holds a key: custodian
 * replies are sealed to terminal session keys.
 */
const CENTER = envInt("CENTER_INDEX", 0);
const SERVICE = `gateway-${CENTER}`;
const privateKey = env("PRIVATE_KEY") as Hex;
const registry = env("REGISTRY") as Address;
const store = storeClient(env("STORE_URL"));
const drandUrl = env("DRAND_URL");
const custodianUrls = env("CUSTODIAN_URLS").split(",");
const cacheDir = env("CACHE_DIR", `.data/gateway-${CENTER}/cache`);
const pin = env("PROCTOR_PIN", "1234");
const SUBMIT_GRACE_ROUNDS = envInt("SUBMIT_GRACE_ROUNDS", 3);
const account = privateKeyToAccount(privateKey);
const chain = await connect(env("RPC_URL"), privateKey);
const chainId = await chain.client.getChainId();
const exam: ExamInfo = await waitForExam(chain.client, registry, SERVICE);
const cfg = exam.config;
if (!sameAddress(cfg.centers[CENTER]?.account, account.address)) throw new Error(`config center ${CENTER} is not this key`);
const drand = httpBeaconSource(drandUrl, chainInfoFromConfig(cfg));

const db = openDb(
  env("DB", `.data/gateway-${CENTER}/gateway.db`),
  `CREATE TABLE IF NOT EXISTS sessions (seq INTEGER PRIMARY KEY AUTOINCREMENT, shift INT, candidate TEXT, terminal TEXT,
     session TEXT UNIQUE, entry TEXT, signature TEXT, replaced INT DEFAULT 0);
   CREATE TABLE IF NOT EXISTS logs (session TEXT, seq INT, body TEXT, PRIMARY KEY (session, seq));
   CREATE TABLE IF NOT EXISTS sheets (shift INT, candidate TEXT, body TEXT, PRIMARY KEY (shift, candidate));
   CREATE TABLE IF NOT EXISTS transfers (shift INT, candidate TEXT, PRIMARY KEY (shift, candidate));
   CREATE TABLE IF NOT EXISTS posted (key TEXT PRIMARY KEY);`,
);
const q = {
  liveSession: db.prepare("SELECT * FROM sessions WHERE shift = ? AND candidate = ? AND replaced = 0"),
  sessionBy: db.prepare("SELECT * FROM sessions WHERE session = ?"),
  addSession: db.prepare("INSERT INTO sessions (shift, candidate, terminal, session, entry, signature) VALUES (?, ?, ?, ?, ?, ?)"),
  replace: db.prepare("UPDATE sessions SET replaced = 1 WHERE session = ?"),
  shiftSessions: db.prepare("SELECT * FROM sessions WHERE shift = ? ORDER BY seq"),
  putLog: db.prepare("INSERT OR REPLACE INTO logs VALUES (?, ?, ?)"),
  candidateLogs: db.prepare(
    "SELECT l.body FROM logs l JOIN sessions s ON s.session = l.session WHERE s.shift = ? AND s.candidate = ? ORDER BY s.seq, l.seq",
  ),
  putSheet: db.prepare("INSERT OR REPLACE INTO sheets VALUES (?, ?, ?)"),
  shiftSheets: db.prepare("SELECT body FROM sheets WHERE shift = ? ORDER BY candidate"),
  sheetOf: db.prepare("SELECT body FROM sheets WHERE shift = ? AND candidate = ?"),
  approve: db.prepare("INSERT OR IGNORE INTO transfers VALUES (?, ?)"),
  approved: db.prepare("SELECT 1 FROM transfers WHERE shift = ? AND candidate = ?"),
  consume: db.prepare("DELETE FROM transfers WHERE shift = ? AND candidate = ?"),
  isPosted: db.prepare("SELECT 1 FROM posted WHERE key = ?"),
  markPosted: db.prepare("INSERT OR IGNORE INTO posted VALUES (?)"),
};

interface SessionRow {
  seq: number;
  shift: number;
  candidate: Hex;
  terminal: string;
  session: Address;
  entry: string;
  signature: Hex;
  replaced: number;
}

let snapshot: Snapshot = await readSnapshot(chain.client, exam);
let questions: Map<Hex, EligibleQuestion> | undefined;
let drandRound = 0;
const allocations = new Map<number, Allocation>();
const bundlePath = (hash: Hex) => join(cacheDir, "bundles", `${hash.toLowerCase()}.json`);
const ZERO = `0x${"00".repeat(32)}` as Hex;

async function prefetch(): Promise<void> {
  if (!snapshot.sealed) return;
  questions ??= (await loadEligible(cfg, snapshot, store.manifest)).questions;
  let fetched = 0;
  for (const qn of questions.values()) {
    if (existsSync(bundlePath(qn.leaf.bundleHash))) continue;
    const b = await store.bundle(qn.leaf.bundleHash);
    if (bundleHash(b) !== qn.leaf.bundleHash) throw new Error("store served a wrong bundle");
    writeJsonFile(bundlePath(qn.leaf.bundleHash), b);
    fetched++;
  }
  if (fetched) log(SERVICE, `prefetched ${fetched} encrypted bundles (${questions.size} eligible)`);
  for (const [shift, root] of snapshot.allocationRoots.entries()) {
    const have = allocations.get(shift);
    if (!root || (have && allocationTree(have).root === root)) continue;
    const a = await store.allocation(shift).catch(() => null);
    if (a && allocationTree(a).root === root) allocations.set(shift, a);
  }
}

async function postBeacon(round: number): Promise<void> {
  const onChain = (await chain.client.readContract({
    address: registry,
    abi: examRegistryAbi,
    functionName: "beaconHash",
    args: [BigInt(round)],
  } as never)) as Hex;
  if (onChain !== ZERO) return;
  const b = await drand.get(round);
  if (b) await send(chain.wallet, chain.client, registry, "postBeacon", [BigInt(round), signatureToEip2537(b.signature)]);
}

/** After a shift, one transaction: roster root and response root. Then publish both lists. */
async function closeShifts(): Promise<void> {
  for (const [shift, w] of snapshot.windows.entries()) {
    const key = `shift:${shift}`;
    if (q.isPosted.get(key) || drandRound < w.end + SUBMIT_GRACE_ROUNDS) continue;
    const rows = q.shiftSessions.all(shift) as unknown as SessionRow[];
    if (rows.length === 0) {
      q.markPosted.run(key);
      continue;
    }
    if (snapshot.latestRound < w.end) await postBeacon(w.end);
    const roster = rows.map((r) => ({ entry: JSON.parse(r.entry) as RosterEntry, centerSignature: r.signature }));
    const sheets = (q.shiftSheets.all(shift) as { body: string }[]).map((r) => JSON.parse(r.body) as SignedSheet);
    const rosterRoot = merkleRoot(roster.map((r) => rosterEntryHash(r.entry)));
    const responseRoot = sheets.length
      ? merkleRoot(sheets.map((s) => responseLeaf(s.sheet.candidateHash, sheetHash(s.sheet))))
      : ZERO;
    await send(chain.wallet, chain.client, registry, "postCenterShift", [shift, rosterRoot, responseRoot, sheets.length]);
    await store.putRoster(CENTER, shift, roster);
    await store.putSheets(CENTER, shift, sheets);
    q.markPosted.run(key);
    log(SERVICE, `shift ${shift} closed: ${roster.length} check-ins, ${sheets.length} sheets on chain`);
  }
}

every(1000, SERVICE, async () => {
  drandRound = (await drand.latest()).round;
  snapshot = await readSnapshot(chain.client, exam);
  await closeShifts();
  await prefetch();
});

const app = new Hono();
app.use("/api/*", cors());
app.onError((e, c) => {
  log(SERVICE, e.message);
  return c.text(e.message, 500);
});

app.get("/api/exam", (c) =>
  c.json({
    registry,
    chainId,
    examId: exam.examId,
    configHash: exam.configHash,
    config: cfg,
    center: { index: CENTER, name: cfg.centers[CENTER]!.name, account: account.address },
    windows: snapshot.windows,
    latestRound: snapshot.latestRound,
    drandRound,
    sealed: snapshot.sealed,
    ready: !!questions && snapshot.allocationRoots.every((r, shift) => !r || allocations.has(shift)),
    allocated: snapshot.windows.map((_, shift) => allocations.get(shift)?.entries.filter((e) => e.center === CENTER).length ?? 0),
  }),
);

app.get("/api/drand/*", async (c) => {
  const res = await fetch(`${drandUrl}${c.req.path.slice("/api/drand".length)}`);
  return c.body(await res.text(), res.status as 200, { "content-type": "application/json" });
});

app.get("/api/questions/:shift", (c) => {
  if (!questions) return c.text("exam not sealed yet", 409);
  const shift = Number(c.req.param("shift"));
  return c.json([...questions.values()].filter((x) => x.leaf.shift === shift));
});

app.get("/api/bundles/:hash", async (c) => {
  const p = bundlePath(c.req.param("hash") as Hex);
  if (existsSync(p)) return c.body(readFileSync(p, "utf8"), 200, { "content-type": "application/json" });
  return c.json(await store.bundle(c.req.param("hash") as Hex));
});

app.post("/api/checkin", async (c) => {
  const body = await c.req.json<{ shift: number; candidateHash: Hex; terminalId: string; session: Address; sessionHpke: Hex }>();
  if (!questions) return c.text("The exam is not sealed yet. Check-in opens once the seal round has passed.", 409);
  const alloc = allocations.get(body.shift);
  if (!alloc) return c.text("The candidate list for this shift has not reached this center yet. Try again shortly.", 409);
  const proof = alloc && allocationProof(alloc, body.candidateHash, CENTER);
  if (!proof) return c.text("This roll number and code are not allocated to this center for this shift.", 403);
  const live = q.liveSession.get(body.shift, body.candidateHash) as unknown as SessionRow | undefined;
  let replaces: Address | null = null;
  if (live && !sameAddress(live.session, body.session)) {
    if (!q.approved.get(body.shift, body.candidateHash))
      return c.text(`Already checked in at terminal ${live.terminal}. A proctor must approve a transfer.`, 409);
    replaces = live.session;
  }
  if (live && sameAddress(live.session, body.session)) {
    return c.json({ entry: JSON.parse(live.entry), centerSignature: live.signature, allocation: proof });
  }
  const entry: RosterEntry = {
    examId: exam.examId,
    shift: body.shift,
    center: CENTER,
    candidateHash: body.candidateHash,
    terminalId: body.terminalId,
    session: body.session,
    sessionHpke: body.sessionHpke,
    replaces,
  };
  const centerSignature = await signHash(account, rosterEntryHash(entry));
  if (replaces) {
    q.replace.run(replaces);
    q.consume.run(body.shift, body.candidateHash);
  }
  q.addSession.run(body.shift, body.candidateHash, body.terminalId, body.session, JSON.stringify(entry), centerSignature);
  log(SERVICE, `check-in shift ${body.shift} terminal ${body.terminalId}${replaces ? " (transfer)" : ""}`);
  return c.json({ entry, centerSignature, allocation: proof });
});

app.post("/api/release/:custodian", async (c) => {
  const url = custodianUrls[Number(c.req.param("custodian"))];
  if (!url) return c.text("unknown custodian", 404);
  const res = await fetch(`${url}/release`, { method: "POST", headers: { "content-type": "application/json" }, body: await c.req.text() });
  return c.body(await res.text(), res.status as 200, { "content-type": res.headers.get("content-type") ?? "text/plain" });
});

app.post("/api/log", async (c) => {
  const { session, entries } = await c.req.json<{ session: Address; entries: LogEntry[] }>();
  const row = q.sessionBy.get(session) as unknown as SessionRow | undefined;
  if (!row || row.replaced) return c.text("unknown or replaced session", 403);
  for (const e of entries) q.putLog.run(session, e.seq, JSON.stringify(e));
  return c.json({ ok: true });
});

app.get("/api/log/:shift/:candidate", (c) => {
  const rows = q.candidateLogs.all(Number(c.req.param("shift")), c.req.param("candidate")) as { body: string }[];
  return c.json(rows.map((r) => JSON.parse(r.body) as LogEntry));
});

app.post("/api/submit", async (c) => {
  const signed = await c.req.json<SignedSheet>();
  const s = signed.sheet;
  const row = q.sessionBy.get(s.session) as unknown as SessionRow | undefined;
  if (!row || row.replaced || row.shift !== s.shift || row.candidate !== s.candidateHash || s.center !== CENTER)
    return c.text("sheet does not match a live session at this center", 403);
  const hash = sheetHash(s);
  if (!sameAddress(await signerOf(hash, signed.signature), s.session)) return c.text("bad session signature", 403);
  if (q.isPosted.get(`shift:${s.shift}`)) return c.text("this shift is already closed", 409);
  q.putSheet.run(s.shift, s.candidateHash, JSON.stringify(signed));
  return c.json({ sheetHash: hash, receiptCode: receiptCode(hash) });
});

app.get("/api/sheet/:shift/:candidate", (c) => {
  const row = q.sheetOf.get(Number(c.req.param("shift")), c.req.param("candidate")) as { body: string } | undefined;
  return row ? c.json(JSON.parse(row.body)) : c.text("no sheet", 404);
});

app.get("/api/proctor/sessions", (c) => {
  if (c.req.query("pin") !== pin) return c.text("wrong PIN", 403);
  const shift = Number(c.req.query("shift") ?? 0);
  const rows = q.shiftSessions.all(shift) as unknown as SessionRow[];
  return c.json(
    rows.map((r) => ({
      candidateHash: r.candidate,
      terminal: r.terminal,
      session: r.session,
      replaced: !!r.replaced,
      submitted: !!q.sheetOf.get(shift, r.candidate),
      transferApproved: !!q.approved.get(shift, r.candidate),
    })),
  );
});

app.post("/api/proctor/transfer", async (c) => {
  const body = await c.req.json<{ pin: string; shift: number; candidateHash: Hex }>();
  if (body.pin !== pin) return c.text("wrong PIN", 403);
  q.approve.run(body.shift, body.candidateHash);
  log(SERVICE, `proctor approved a transfer in shift ${body.shift}`);
  return c.json({ ok: true });
});

const dist = process.env.CLIENT_DIST;
if (dist) {
  app.use("/*", serveStatic({ root: dist }));
  app.get("*", (c) =>
    existsSync(join(dist, "index.html")) ? c.html(readFileSync(join(dist, "index.html"), "utf8")) : c.text("exam client not built", 404),
  );
}

serve(app, envInt("PORT", 8800 + CENTER), SERVICE);
