import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import {
    bundleHash,
    centerShifts,
    getJson,
    HttpError,
    postJson,
    readExam,
    readSnapshot,
    TerminalSession,
    type Bundle,
    type Hex,
    type PaperItem,
    type ReleaseReply,
} from "@eplp/protocol";
import { connect } from "@eplp/node-kit";
import { demoQuestions, SUBJECTS } from "./demo.ts";
import {
    allocateDemo,
    auditDeployment,
    DATA,
    devKey,
    ROLES,
    scoreExam,
    setup,
    submitDemoSetters,
    type AdmitCard,
} from "./ops.ts";
import { Supervisor, waitFor } from "./procs.ts";
import {
    baseDeployment,
    startChainAndBeacon,
    startServices,
    type Ports,
} from "./stack.ts";

const ports: Ports = {
    rpc: 18545,
    beacon: 18780,
    store: 18781,
    custodian: 18790,
    gateway: 18800,
    portal: 15173,
};
const t0 = Date.now();
const step = (m: string) =>
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const ok = (m: string) => console.log(`        ✓ ${m}`);

async function refusal(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (e) {
        return e instanceof HttpError
            ? `${e.status} ${e.body}`
            : e instanceof Error
              ? e.message
              : String(e);
    }
    throw new Error("expected a refusal but the call succeeded");
}

rmSync(DATA, { recursive: true, force: true });
const sup = new Supervisor(join(DATA, "logs"));
try {
    const besu = process.env.E2E_CHAIN === "besu";
    step(
        `starting ${besu ? "4 Besu QBFT validators" : "Anvil"} (prague) and the dev drand beacon`,
    );
    await startChainAndBeacon(sup, ports, {
        beaconPeriod: 1,
        dataDir: DATA,
        besu,
    });

    step(
        "authority deploys the registry and freezes the config in one transaction",
    );
    const dep = await setup(
        baseDeployment(ports),
        {
            sealIn: 50,
            startGap: 12,
            duration: 40,
            shiftGap: 4,
            answersGap: 8,
            lateEntry: 8,
        },
        { centers: 2, shifts: 2, perShift: 5, perPool: 5 },
    );
    const client = createPublicClient({
        transport: http(dep.rpcUrl, { batch: true }),
    }) as PublicClient;
    const exam = await readExam(client, dep.registry);
    const cfg = exam.config;
    ok(
        `registry ${dep.registry}, config hash ${exam.configHash.slice(0, 14)}…, seal round ${cfg.sealRound}`,
    );

    step("starting store, 3 custodians, 2 center gateways");
    await startServices(sup, dep, ports);

    step("setters seal and submit");
    await submitDemoSetters(dep, ok);
    const badSetter = await connect(dep.rpcUrl, devKey(ROLES.setter(0)));
    const wrongCount = await refusal(
        badSetter.client.simulateContract({
            account: badSetter.wallet.account,
            address: dep.registry,
            abi: (await import("@eplp/protocol")).examRegistryAbi,
            functionName: "submitSetterRoot",
            args: [`0x${"11".repeat(32)}`, 3],
        }),
    );
    assert.match(wrongCount, /WrongCount/);
    ok("contract refuses a setter root with the wrong question count");
    const anyBundle = await getJson<Bundle>(
        `${dep.storeUrl}/bundles/${(await getJson<{ leaves: { bundleHash: Hex }[] }>(`${dep.storeUrl}/manifests/${cfg.setters[0]!.account}`)).leaves[0]!.bundleHash}`,
    );
    const forged = { ...anyBundle, index: 99 };
    assert.match(
        await refusal(
            postJson(
                `${dep.storeUrl}/bundles/${bundleHash(forged)}`,
                forged,
                "PUT",
            ),
        ),
        /409/,
    );
    ok("store refuses a bundle that is not under an on-chain root");

    step(
        "custodians fetch bundles, check their shares, and acknowledge on chain",
    );
    await waitFor(
        "every setter acknowledged by the threshold",
        async () => {
            const s = await readSnapshot(client, exam);
            return s.setters.every((x) => x.eligible);
        },
        90_000,
    );
    ok(
        `all ${cfg.setters.length} setter batches eligible (≥${cfg.threshold} of ${cfg.custodians.length} acknowledgments)`,
    );

    step("authority allocates candidates and publishes allocation roots");
    const cards = await allocateDemo(dep, 4);
    const card = (shift: number, center: number, n: number): AdmitCard =>
        cards.filter((c) => c.shift === shift && c.center === center)[n]!;
    ok(`${cards.length} admit cards, roll numbers never on chain`);

    step("waiting for the seal beacon; gateways prefetch ciphertext");
    await waitFor(
        "sealed and gateways ready",
        async () => {
            const [g0, g1] = await Promise.all(
                dep.gatewayUrls.map((u) => TerminalSession.exam(u)),
            );
            const custodians = await Promise.all(
                dep.custodianUrls.map((u) =>
                    getJson<{ questions: number }>(`${u}/health`),
                ),
            );
            return (
                g0!.ready &&
                g1!.ready &&
                g0!.allocated[0]! > 0 &&
                custodians.every((h) => h.questions > 0)
            );
        },
        120_000,
    );
    const snapshot = await readSnapshot(client, exam);
    assert.equal(snapshot.sealed, true);
    ok(
        `sealed at round ${snapshot.latestRound}; both gateways hold every eligible ciphertext`,
    );

    const g0 = dep.gatewayUrls[0]!;
    const g1 = dep.gatewayUrls[1]!;

    step("check-in before T, and the refusals around it");
    const a = card(0, 0, 0);
    const b = card(0, 0, 1);
    const c = card(0, 1, 0);
    const sA = await TerminalSession.start(
        g0,
        0,
        "T-01",
        a.rollNo,
        a.checkInCode,
    );
    const sB = await TerminalSession.start(
        g0,
        0,
        "T-02",
        b.rollNo,
        b.checkInCode,
    );
    const sC = await TerminalSession.start(
        g1,
        0,
        "B-01",
        c.rollNo,
        c.checkInCode,
    );
    assert.match(
        await refusal(
            TerminalSession.start(g0, 0, "T-09", c.rollNo, c.checkInCode),
        ),
        /403.*not allocated/,
    );
    ok("a candidate allocated to Hall B cannot check in at Hall A");
    assert.match(
        await refusal(TerminalSession.start(g0, 0, "T-09", a.rollNo, "WRONG1")),
        /403/,
    );
    ok("a wrong check-in code is refused");
    assert.match(
        await refusal(
            TerminalSession.start(g0, 0, "T-03", b.rollNo, b.checkInCode),
        ),
        /409.*proctor/,
    );
    ok("a second terminal for the same candidate needs a proctor transfer");

    const startRound = snapshot.windows[0]!.start;
    assert.equal(await sA.beacons.get(startRound), null);
    ok(
        `the start beacon (round ${startRound}) does not exist yet, so no one can compute the paper`,
    );
    const early = await sA.beacons.latest();
    for (const j of [0, 1, 2]) {
        const why = await refusal(
            postJson<ReleaseReply>(`${g0}/api/release/${j}`, {
                ...sA.checkIn,
                beacon: early,
            }),
        );
        assert.match(why, /403.*start beacon/);
    }
    ok(
        "every custodian refuses a key request carrying any beacon other than the shift's start beacon",
    );

    step(`waiting for T (round ${startRound})`);
    const [pA, pB, pC] = await Promise.all([
        sA.unlock(),
        sB.unlock(),
        sC.unlock(),
    ]);
    const perPaper = cfg.shifts[0]!.perPool.reduce((x, y) => x + y, 0);
    for (const p of [pA, pB, pC]) assert.equal(p.items.length, perPaper);
    const setOf = (items: PaperItem[]) => new Set(items.map((i) => i.qid));
    assert.deepEqual(setOf(pA.items), setOf(pC.items));
    assert.notDeepEqual(
        pA.items.map((i) => i.qid),
        pB.items.map((i) => i.qid),
    );
    assert.equal(JSON.stringify([pA, pB, pC]).includes('"correct"'), false);
    ok(
        `each terminal opened ${perPaper} questions with ${pA.custodiansAnswered.length} custodians; same paper in both halls`,
    );
    ok(
        "question order differs per candidate; no answer key reached any terminal",
    );

    const key = answerKey();
    const correctDisplay = (it: PaperItem) =>
        it.options.indexOf(key.get(keyOf(it.text, it.options))!);
    const round = () => sA.latestRound();

    step("candidates answer; B's terminal dies halfway");
    for (const it of pA.items)
        sA.answer(it.qid, correctDisplay(it), await round());
    pB.items
        .slice(0, 8)
        .forEach((it) => sB.answer(it.qid, correctDisplay(it), 0));
    await Promise.all([sA.flush(), sB.flush()]);
    const proctorList = await getJson<{ candidateHash: Hex }[]>(
        `${g0}/api/proctor/sessions?pin=2468&shift=0`,
    );
    assert.equal(proctorList.length, 2);
    await postJson(`${g0}/api/proctor/transfer`, {
        pin: "2468",
        shift: 0,
        candidateHash: sB.candidate,
    });
    const sB2 = await TerminalSession.start(
        g0,
        0,
        "T-07",
        b.rollNo,
        b.checkInCode,
    );
    const pB2 = await sB2.unlock();
    assert.deepEqual(setOf(pB2.items), setOf(pB.items));
    const restored = await sB2.restore();
    assert.equal(restored, 8);
    for (const it of pB2.items) {
        if (sB2.answers.get(it.qid) !== null) continue;
        sB2.answer(it.qid, (correctDisplay(it) + 1) % 4, await round());
    }
    ok(
        "proctor-approved transfer: new session got keys, 8 backed-up answers restored",
    );
    assert.match(await refusal(sB.submit(await round())), /403/);
    ok("the replaced session can no longer submit");

    const rA = await sA.submit(await round());
    const rB = await sB2.submit(await round());
    ok(
        `signed sheets submitted; receipt codes ${rA.receiptCode}, ${rB.receiptCode}`,
    );

    step("late entry after the window closes");
    await waitFor(
        "late window to pass",
        async () => (await sA.latestRound()) > startRound + cfg.lateEntryRounds,
        60_000,
    );
    const late = await TerminalSession.start(
        g0,
        0,
        "T-08",
        card(0, 0, 2).rollNo,
        card(0, 0, 2).checkInCode,
    );
    assert.match(await refusal(late.unlock()), /late entry window has closed/);
    ok("custodians refuse key release after lateEntryRounds");
    await postJson(`${g1}/api/proctor/transfer`, {
        pin: "2468",
        shift: 0,
        candidateHash: sC.candidate,
    });
    const sC2 = await TerminalSession.start(
        g1,
        0,
        "B-05",
        c.rollNo,
        c.checkInCode,
    );
    assert.deepEqual(setOf((await sC2.unlock()).items), setOf(pC.items));
    const rC = await sC2.submit(await round());
    ok(
        `a proctor transfer still gets keys after late entry closes, until the shift ends (receipt ${rC.receiptCode})`,
    );

    step(`shift 1 (round ${snapshot.windows[1]!.start})`);
    const e = card(1, 0, 0);
    const sE = await TerminalSession.start(
        g0,
        1,
        "T-01",
        e.rollNo,
        e.checkInCode,
    );
    const pE = await sE.unlock();
    assert.equal(
        [...setOf(pE.items)].some((q) => setOf(pA.items).has(q)),
        false,
    );
    for (const it of pE.items)
        sE.answer(it.qid, correctDisplay(it), await round());
    await sE.submit(await round());
    ok("shift 1 paper shares no question with shift 0");

    step("gateways close shifts on chain; custodians publish receipts");
    await waitFor(
        "both shifts posted by the centers that ran them",
        async () => {
            const posted = await centerShifts(client, dep.registry);
            return posted.length >= 3 && posted;
        },
        120_000,
    );
    ok("center roots on chain: roster and response roots per shift");

    step(`waiting for the answers round (${cfg.answersRound})`);
    await waitFor(
        "answers beacon on chain",
        async () =>
            (await readSnapshot(client, exam)).latestRound >= cfg.answersRound,
        120_000,
    );
    const scored = await waitFor(
        "scoring",
        async () => scoreExam(dep),
        60_000,
        2000,
    );
    assert.equal(scored.candidates, 4);
    const results = await getJson<{ candidateHash: Hex; score: number }[]>(
        `${dep.storeUrl}/results`,
    );
    const scoreOf = (s: TerminalSession) =>
        results.find((r) => r.candidateHash === s.candidate)!.score;
    assert.equal(scoreOf(sA), perPaper * cfg.marksCorrect);
    assert.equal(
        scoreOf(sB2),
        8 * cfg.marksCorrect + (perPaper - 8) * cfg.marksWrong,
    );
    assert.equal(scoreOf(sC2), 0);
    assert.equal(scoreOf(sE), perPaper * cfg.marksCorrect);
    ok(
        `scores A=${scoreOf(sA)} B=${scoreOf(sB2)} C=${scoreOf(sC2)} E=${scoreOf(sE)}, as answered`,
    );

    step("independent audit from public data");
    await new Promise((r) => setTimeout(r, 3000));
    const checks = await auditDeployment(dep);
    for (const ch of checks)
        console.log(`        ${ch.ok ? "✓" : "✗"} ${ch.name}: ${ch.detail}`);
    assert.equal(
        checks.every((ch) => ch.ok),
        true,
        "audit failed",
    );

    step(`END TO END PASSED in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
} catch (err) {
    console.error(
        `\nFAILED: ${err instanceof Error ? err.stack : err}\nlogs: ${join(DATA, "logs")}`,
    );
    process.exitCode = 1;
} finally {
    sup.stopAll();
}

function keyOf(text: string, options: readonly string[]): string {
    return `${text}|${[...options].sort().join("|")}`;
}

function answerKey(): Map<string, string> {
    const m = new Map<string, string>();
    const pools = Object.keys(SUBJECTS) as (keyof typeof SUBJECTS)[];
    for (let i = 0; i < 6; i++) {
        for (const q of demoQuestions(pools[Math.floor(i / 2)]!, 10, 1000 + i))
            m.set(keyOf(q.text, q.options), q.options[q.correct]);
    }
    return m;
}
