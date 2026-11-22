import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
    createPublicClient,
    http,
    isAddress,
    type Address,
    type PublicClient,
} from "viem";
import {
    allocationTree,
    bundleHash,
    examRegistryAbi,
    manifestRoot,
    merkleRoot,
    receiptHash,
    responseLeaf,
    resultLeaf,
    rosterEntryHash,
    sheetHash,
    type Allocation,
    type Bundle,
    type ExamInfo,
    type Hex,
    type Manifest,
    type Result,
    type SignedReceipt,
    type SignedRosterEntry,
    type SignedSheet,
} from "@eplp/protocol";
import {
    env,
    envInt,
    log,
    readJsonFile,
    serve,
    waitForExam,
    writeJsonFile,
} from "@eplp/node-kit";

/**
 * The public store. It holds only ciphertext and hash-committed public documents,
 * and it accepts a write only when the document matches a root already on chain.
 * So the store needs no trust: it can refuse service, but it cannot substitute content.
 */
const SERVICE = "store";
const dir = env("STORE_DIR", ".data/store");
const registry = env("REGISTRY") as Address;
const client = createPublicClient({
    transport: http(env("RPC_URL"), { batch: true }),
}) as PublicClient;
let exam: ExamInfo | undefined;

const ZERO = `0x${"00".repeat(32)}`;
const path = (...parts: (string | number)[]) =>
    join(dir, ...parts.map(String)) + ".json";
const read = <T>(...parts: (string | number)[]) =>
    readJsonFile<T>(path(...parts));
const reject = (c: Context, msg: string) => c.text(msg, 409);
const call = (functionName: string, args: unknown[]) =>
    client.readContract({
        address: registry,
        abi: examRegistryAbi,
        functionName,
        args,
    } as never) as Promise<unknown>;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const rootOrEmpty = (leaves: Hex[]) =>
    leaves.length ? merkleRoot(leaves) : ZERO;

const app = new Hono();
app.use(cors());
app.use(async (c, next) => {
    exam ??= await waitForExam(client, registry, SERVICE);
    await next();
});
app.get("/health", (c) => c.json({ ok: true }));

app.put("/manifests/:setter", async (c) => {
    const setter = c.req.param("setter");
    const m = await c.req.json<Manifest>();
    if (
        !isAddress(setter) ||
        !eq(m.setter, setter) ||
        m.examId !== exam!.examId
    )
        return reject(c, "wrong setter or exam");
    const root = (await call("setterRoot", [setter])) as Hex;
    if (root === ZERO || manifestRoot(m) !== root)
        return reject(c, "manifest does not match the setter's on-chain root");
    writeJsonFile(path("manifests", setter.toLowerCase()), m);
    return c.json({ ok: true });
});

app.get("/manifests/:setter", (c) => {
    const m = read<Manifest>("manifests", c.req.param("setter").toLowerCase());
    return m ? c.json(m) : c.text("no manifest", 404);
});

app.post("/bundles/missing", async (c) => {
    const hashes = await c.req.json<Hex[]>();
    return c.json({
        missing: hashes.filter(
            (h) => !existsSync(path("bundles", h.toLowerCase())),
        ),
    });
});

app.put("/bundles/:hash", async (c) => {
    const hash = c.req.param("hash").toLowerCase() as Hex;
    const b = await c.req.json<Bundle>();
    if (bundleHash(b) !== hash)
        return reject(c, "bundle does not hash to its name");
    const m = read<Manifest>("manifests", b.setter.toLowerCase());
    const root = (await call("setterRoot", [b.setter])) as Hex;
    if (!m || manifestRoot(m) !== root)
        return reject(
            c,
            "upload the manifest for the current on-chain root first",
        );
    if (
        !m.leaves.some(
            (l) =>
                l.bundleHash === hash &&
                l.shift === b.shift &&
                l.index === b.index,
        )
    )
        return reject(c, "bundle is not in the setter's manifest");
    writeJsonFile(path("bundles", hash), b);
    return c.json({ ok: true });
});

app.get("/bundles/:hash", (c) => {
    const p = path("bundles", c.req.param("hash").toLowerCase());
    return existsSync(p)
        ? c.body(readFileSync(p, "utf8"), 200, {
              "content-type": "application/json",
          })
        : c.text("no bundle", 404);
});

app.put("/allocations/:shift", async (c) => {
    const shift = Number(c.req.param("shift"));
    const a = await c.req.json<Allocation>();
    if (a.shift !== shift || a.examId !== exam!.examId)
        return reject(c, "wrong shift or exam");
    if (
        allocationTree(a).root !==
        ((await call("allocationRoot", [shift])) as Hex)
    )
        return reject(c, "allocation does not match the on-chain root");
    writeJsonFile(path("allocations", shift), a);
    return c.json({ ok: true });
});

app.get("/allocations/:shift", (c) => {
    const a = read<Allocation>("allocations", c.req.param("shift"));
    return a ? c.json(a) : c.text("no allocation", 404);
});

const centerRoots = async (center: number, shift: number) => {
    const account = exam!.config.centers[center]?.account;
    if (!account) return null;
    return (await call("centerShift", [account, shift])) as {
        rosterRoot: Hex;
        responseRoot: Hex;
        sheets: number;
    };
};

app.put("/rosters/:center/:shift", async (c) => {
    const [center, shift] = [
        Number(c.req.param("center")),
        Number(c.req.param("shift")),
    ];
    const roster = await c.req.json<SignedRosterEntry[]>();
    const roots = await centerRoots(center, shift);
    if (
        !roots ||
        rootOrEmpty(roster.map((r) => rosterEntryHash(r.entry))) !==
            roots.rosterRoot
    )
        return reject(c, "roster does not match the center's on-chain root");
    writeJsonFile(path("rosters", center, shift), roster);
    return c.json({ ok: true });
});

app.put("/sheets/:center/:shift", async (c) => {
    const [center, shift] = [
        Number(c.req.param("center")),
        Number(c.req.param("shift")),
    ];
    const sheets = await c.req.json<SignedSheet[]>();
    const roots = await centerRoots(center, shift);
    const leaves = sheets.map((s) =>
        responseLeaf(s.sheet.candidateHash, sheetHash(s.sheet)),
    );
    if (!roots || rootOrEmpty(leaves) !== roots.responseRoot)
        return reject(c, "sheets do not match the center's on-chain root");
    writeJsonFile(path("sheets", center, shift), sheets);
    return c.json({ ok: true });
});

app.put("/receipts/:custodian/:shift", async (c) => {
    const [custodian, shift] = [
        Number(c.req.param("custodian")),
        Number(c.req.param("shift")),
    ];
    const receipts = await c.req.json<SignedReceipt[]>();
    const account = exam!.config.custodians[custodian]?.account;
    const root = account
        ? ((await call("receiptRoot", [account, shift])) as Hex)
        : null;
    if (
        !root ||
        rootOrEmpty(receipts.map((r) => receiptHash(r.receipt))) !== root
    )
        return reject(c, "receipts do not match the custodian's on-chain root");
    writeJsonFile(path("receipts", custodian, shift), receipts);
    return c.json({ ok: true });
});

app.put("/results", async (c) => {
    const results = await c.req.json<Result[]>();
    if (
        rootOrEmpty(results.map(resultLeaf)) !==
        ((await call("resultRoot", [])) as Hex)
    )
        return reject(c, "results do not match the on-chain root");
    writeJsonFile(path("results"), results);
    return c.json({ ok: true });
});

for (const kind of ["rosters", "sheets", "receipts"] as const) {
    app.get(`/${kind}/:a/:shift`, (c) => {
        const v = read<unknown>(kind, c.req.param("a"), c.req.param("shift"));
        return v ? c.json(v) : c.text(`no ${kind}`, 404);
    });
}

app.get("/results", (c) => {
    const v = read<Result[]>("results");
    return v ? c.json(v) : c.text("no results", 404);
});

serve(app, envInt("PORT", 8781), SERVICE);
