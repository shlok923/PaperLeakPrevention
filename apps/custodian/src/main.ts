import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
    bundleHash,
    canonicalBytes,
    chainInfoFromConfig,
    checkManifest,
    examRegistryAbi,
    fromHex,
    httpBeaconSource,
    leafId,
    loadEligible,
    merkleRoot,
    openShares,
    qidsHash,
    readSnapshot,
    receiptHash,
    releasedQids,
    rosterEntryHash,
    sameAddress,
    seal,
    selectionSeed,
    send,
    shiftPlan,
    signatureToEip2537,
    signerOf,
    signHash,
    storeClient,
    verifyAllocation,
    verifyBeacon,
    beaconsOnChain,
    type EligibleQuestion,
    type ExamInfo,
    type Hex,
    type HpkeKeyPair,
    type Receipt,
    type ReleaseReply,
    type ReleaseRequest,
    type ShareItem,
    type Snapshot,
} from "@eplp/protocol";
import {
    connect,
    env,
    envInt,
    every,
    log,
    openDb,
    readJsonFile,
    serve,
    waitForExam,
} from "@eplp/node-kit";

const INDEX = envInt("INDEX");
const SERVICE = `custodian-${INDEX}`;
const privateKey = env("PRIVATE_KEY") as Hex;
const registry = env("REGISTRY") as Address;
const hpke = readJsonFile<HpkeKeyPair>(env("HPKE_KEY_FILE"));
if (!hpke) throw new Error("HPKE key file missing");
const store = storeClient(env("STORE_URL"));
const drandUrl = env("DRAND_URL");
const account = privateKeyToAccount(privateKey);
const chain = await connect(env("RPC_URL"), privateKey);
const exam: ExamInfo = await waitForExam(chain.client, registry, SERVICE);
const cfg = exam.config;
const me = cfg.custodians[INDEX];
if (
    !me ||
    !sameAddress(me.account, account.address) ||
    me.hpkeKey !== hpke.publicKey
)
    throw new Error(`config custodian ${INDEX} does not match this key`);
const drand = httpBeaconSource(drandUrl, chainInfoFromConfig(cfg));
const info = chainInfoFromConfig(cfg);

const db = openDb(
    env("DB", `.data/custodian-${INDEX}/custodian.db`),
    `CREATE TABLE IF NOT EXISTS shares (qid TEXT PRIMARY KEY, setter TEXT, root TEXT, share_q TEXT, share_a TEXT);
   CREATE TABLE IF NOT EXISTS sessions (shift INT, candidate TEXT, session TEXT, transfers INT, PRIMARY KEY (shift, candidate));
   CREATE TABLE IF NOT EXISTS receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, shift INT, body TEXT, signature TEXT);
   CREATE TABLE IF NOT EXISTS posted (key TEXT PRIMARY KEY);`,
);
const putShare = db.prepare(
    "INSERT OR REPLACE INTO shares VALUES (?, ?, ?, ?, ?)",
);
const getShare = db.prepare(
    "SELECT share_q, share_a FROM shares WHERE qid = ?",
);
const getSession = db.prepare(
    "SELECT session, transfers FROM sessions WHERE shift = ? AND candidate = ?",
);
const upsertSession = db.prepare(
    "INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?)",
);
const addReceipt = db.prepare(
    "INSERT INTO receipts (shift, body, signature) VALUES (?, ?, ?)",
);
const shiftReceipts = db.prepare(
    "SELECT body, signature FROM receipts WHERE shift = ? ORDER BY seq",
);
const isPosted = db.prepare("SELECT 1 FROM posted WHERE key = ?");
const markPosted = db.prepare("INSERT OR IGNORE INTO posted VALUES (?)");

let snapshot: Snapshot = await readSnapshot(chain.client, exam);
let questions: Map<Hex, EligibleQuestion> | undefined;
let drandRound = 0;

const call = (functionName: string, args: unknown[]) =>
    chain.client.readContract({
        address: registry,
        abi: examRegistryAbi,
        functionName,
        args,
    } as never) as Promise<unknown>;

/** Fetch every bundle under `root`, open this custodian's shares, and keep them. */
async function takeShares(setter: Address, root: Hex): Promise<void> {
    const m = await store.manifest(setter);
    checkManifest(m, root);
    for (const leaf of m.leaves) {
        const bundle = await store.bundle(leaf.bundleHash);
        if (bundleHash(bundle) !== leaf.bundleHash)
            throw new Error(`store served a wrong bundle for ${setter}`);
        const { shareQ, shareA } = await openShares(
            bundle,
            INDEX,
            hpke!.privateKey,
        );
        const qid = leafId(m.examId, setter, leaf);
        putShare.run(qid, setter, root, shareQ, shareA);
    }
}

async function acknowledgeSetters(): Promise<void> {
    if (snapshot.sealed) return;
    for (const s of snapshot.setters) {
        if (!s.root) continue;
        if (
            (await call("hasAcknowledged", [
                account.address,
                s.account,
            ])) as boolean
        )
            continue;
        await takeShares(s.account, s.root);
        await send(chain.wallet, chain.client, registry, "acknowledge", [
            s.account,
            s.root,
        ]);
        log(
            SERVICE,
            `acknowledged ${s.account.slice(0, 10)} root ${s.root.slice(0, 10)}`,
        );
    }
}

/** Anyone may post beacons; custodians do it for every round the contract's rules depend on. */
async function postMilestoneBeacons(): Promise<void> {
    const milestones = [
        cfg.sealRound,
        ...snapshot.windows.flatMap((w) => [w.start, w.end]),
        cfg.answersRound,
    ]
        .filter((r) => r <= drandRound)
        .sort((a, b) => a - b);
    for (const round of milestones) {
        if (
            ((await call("beaconHash", [BigInt(round)])) as Hex) !==
            `0x${"00".repeat(32)}`
        )
            continue;
        const b = await drand.get(round);
        if (!b) continue;
        await send(chain.wallet, chain.client, registry, "postBeacon", [
            BigInt(round),
            signatureToEip2537(b.signature),
        ]);
        log(SERVICE, `posted beacon ${round}`);
    }
}

async function loadQuestions(): Promise<void> {
    if (!snapshot.sealed || questions) return;
    const loaded = await loadEligible(cfg, snapshot, store.manifest);
    for (const s of snapshot.setters.filter((x) => x.eligible && x.root)) {
        const mine = [...loaded.questions.values()].filter((q) =>
            sameAddress(q.setter, s.account),
        );
        if (mine.some((q) => !getShare.get(q.qid)))
            await takeShares(s.account, s.root!);
    }
    questions = loaded.questions;
    log(SERVICE, `sealed: ${questions.size} eligible questions`);
}

async function postShiftReceipts(): Promise<void> {
    for (const [shift, w] of snapshot.windows.entries()) {
        const key = `receipts:${shift}`;
        if (
            isPosted.get(key) ||
            drandRound <= w.end ||
            snapshot.latestRound < w.start
        )
            continue;
        const rows = shiftReceipts.all(shift) as {
            body: string;
            signature: Hex;
        }[];
        if (rows.length > 0) {
            const receipts = rows.map((r) => ({
                receipt: JSON.parse(r.body) as Receipt,
                signature: r.signature,
            }));
            const root = merkleRoot(
                receipts.map((r) => receiptHash(r.receipt)),
            );
            await send(chain.wallet, chain.client, registry, "postReceipts", [
                shift,
                root,
                receipts.length,
            ]);
            await store.putReceipts(INDEX, shift, receipts);
            log(
                SERVICE,
                `posted ${receipts.length} receipts for shift ${shift}`,
            );
        }
        markPosted.run(key);
    }
}

every(1000, SERVICE, async () => {
    drandRound = (await drand.latest()).round;
    snapshot = await readSnapshot(chain.client, exam);
    await acknowledgeSetters();
    await postMilestoneBeacons();
    await loadQuestions();
    await postShiftReceipts();
});

const plans = new Map<string, Hex[]>();
function selected(shift: number, startSignature: string): Hex[] {
    const seed = selectionSeed(
        exam.examId,
        shift,
        signatureToEip2537(startSignature),
    );
    const cached = plans.get(seed);
    if (cached) return cached;
    const qids = releasedQids(shiftPlan(cfg, questions!, shift, seed));
    plans.set(seed, qids);
    return qids;
}

class Refusal extends Error {}
const refuse = (cond: unknown, msg: string) => {
    if (cond) throw new Refusal(msg);
};

const app = new Hono();
app.use(cors());
app.onError((e, c) =>
    e instanceof Refusal
        ? c.text(e.message, 403)
        : (log(SERVICE, e.message), c.text(e.message, 500)),
);
app.get("/health", (c) =>
    c.json({
        ok: true,
        index: INDEX,
        sealed: snapshot.sealed,
        questions: questions?.size ?? 0,
        drandRound,
    }),
);

app.post("/release", async (c) => {
    const req = await c.req.json<ReleaseRequest>();
    const { entry } = req;
    const shift = entry.shift;
    const window = snapshot.windows[shift];
    refuse(entry.examId !== exam.examId || !window, "wrong exam or shift");
    refuse(!snapshot.sealed || !questions, "exam is not sealed yet");
    refuse(
        req.beacon.round !== window!.start || !verifyBeacon(info, req.beacon),
        "not the verified start beacon for this shift",
    );
    const now = (await drand.latest()).round;
    refuse(
        now < window!.start,
        "my drand clock has not reached the start round",
    );
    const transfer = entry.replaces !== null;
    refuse(
        transfer
            ? now > window!.end
            : now > window!.start + cfg.lateEntryRounds,
        transfer ? "the shift has ended" : "late entry window has closed",
    );
    const center = cfg.centers[entry.center];
    refuse(
        !center || snapshot.centerRevoked[entry.center],
        "unknown or revoked center",
    );
    refuse(
        !sameAddress(
            await signerOf(rosterEntryHash(entry), req.centerSignature),
            center!.account,
        ),
        "roster entry not signed by its center",
    );
    const allocRoot = snapshot.allocationRoots[shift];
    refuse(
        !allocRoot ||
            !verifyAllocation(
                allocRoot,
                { candidateHash: entry.candidateHash, center: entry.center },
                req.allocation,
            ),
        "candidate is not allocated to this center and shift",
    );

    const existing = getSession.get(shift, entry.candidateHash) as
        { session: string; transfers: number } | undefined;
    if (!existing)
        upsertSession.run(shift, entry.candidateHash, entry.session, 0);
    else if (!sameAddress(existing.session, entry.session)) {
        refuse(
            !sameAddress(entry.replaces, existing.session),
            "candidate already has a live session",
        );
        refuse(existing.transfers >= 3, "too many terminal transfers");
        upsertSession.run(
            shift,
            entry.candidateHash,
            entry.session,
            existing.transfers + 1,
        );
    }

    const qids = selected(shift, req.beacon.signature);
    const items: ShareItem[] = qids.flatMap((qid) => {
        const row = getShare.get(qid) as { share_q: Hex } | undefined;
        return row ? [{ qid, share: row.share_q }] : [];
    });
    const sealed = await seal(
        entry.sessionHpke,
        canonicalBytes(items),
        fromHex(rosterEntryHash(entry)),
    );
    const receipt: Receipt = {
        examId: exam.examId,
        shift,
        custodian: INDEX,
        candidateHash: entry.candidateHash,
        session: entry.session,
        startRound: window!.start,
        servedRound: now,
        qidsHash: qidsHash(items.map((i) => i.qid)),
    };
    const signature = await signHash(account, receiptHash(receipt));
    addReceipt.run(shift, JSON.stringify(receipt), signature);
    const reply: ReleaseReply = {
        custodian: INDEX,
        sealed,
        receipt,
        signature,
    };
    return c.json(reply);
});

/** After answers unlock, the shares of every selected question become public for scoring and audit. */
app.get("/released/:shift", async (c) => {
    const shift = Number(c.req.param("shift"));
    const window = snapshot.windows[shift];
    refuse(
        !window || snapshot.latestRound < cfg.answersRound,
        "answers have not unlocked on chain",
    );
    const sig = (await beaconsOnChain(chain.client, registry)).get(
        window!.start,
    );
    refuse(!sig, "start beacon for this shift was never posted");
    const b = await drand.get(window!.start);
    const qids = selected(shift, b!.signature);
    return c.json(
        qids.flatMap((qid) => {
            const row = getShare.get(qid) as
                { share_q: Hex; share_a: Hex } | undefined;
            return row
                ? [{ qid, shareQ: row.share_q, shareA: row.share_a }]
                : [];
        }),
    );
});

serve(app, envInt("PORT", 8790 + INDEX), SERVICE);
