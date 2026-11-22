import type { PublicClient } from "viem";
import type { Hex } from "./bytes.ts";
import { bundleHash, openAnswer, openQuestion } from "./bundle.ts";
import {
    beaconsOnChain,
    centerShifts,
    readSnapshot,
    type ExamInfo,
    type Snapshot,
} from "./chain.ts";
import { chainInfoFromConfig, configHash } from "./config.ts";
import {
    publicKeyToEip2537,
    signatureToEip2537,
    verifyBeacon,
    type BeaconSource,
} from "./drand.ts";
import { merkleRoot } from "./hash.ts";
import {
    allocationTree,
    allocationProof,
    receiptHash,
    resultLeaf,
    rosterEntryHash,
    sameAddress,
    scoreSheet,
    sheetHash,
    signerOf,
    verifyAllocation,
    type Result,
    type SignedSheet,
} from "./session.ts";
import { selectionSeed } from "./shuffle.ts";
import { shiftPlan, releasedQids, type EligibleQuestion } from "./state.ts";
import {
    getJson,
    loadEligible,
    type SignedRosterEntry,
    type StoreClient,
} from "./store-client.ts";

export interface ReleasedShare {
    qid: Hex;
    shareQ: Hex;
    shareA: Hex;
}

export interface ExamRecords {
    exam: ExamInfo;
    snapshot: Snapshot;
    questions: Map<Hex, EligibleQuestion>;
    sheets: {
        center: number;
        shift: number;
        sheets: SignedSheet[];
        roster: SignedRosterEntry[];
    }[];
    released: Map<number, Map<Hex, ReleasedShare[]>>;
    beacons: Map<number, Hex>;
}

/** Everything published after the exam: chain state, store documents, custodians' released shares. */
export async function collectRecords(
    client: PublicClient,
    exam: ExamInfo,
    store: StoreClient,
    custodianUrls: readonly string[],
): Promise<ExamRecords> {
    const snapshot = await readSnapshot(client, exam);
    const { questions } = await loadEligible(
        exam.config,
        snapshot,
        store.manifest,
    );
    const posted = await centerShifts(client, exam.registry);
    const sheets = await Promise.all(
        posted.map(async (p) => {
            const center = exam.config.centers.findIndex((c) =>
                sameAddress(c.account, p.center),
            );
            const [s, roster] = await Promise.all([
                store.sheets(center, p.shift).catch(() => []),
                store.roster(center, p.shift),
            ]);
            return { center, shift: p.shift, sheets: s, roster };
        }),
    );
    const released = new Map<number, Map<Hex, ReleasedShare[]>>();
    for (const shift of exam.config.shifts.keys()) {
        const byQid = new Map<Hex, ReleasedShare[]>();
        const replies = await Promise.allSettled(
            custodianUrls.map((u) =>
                getJson<ReleasedShare[]>(`${u}/released/${shift}`),
            ),
        );
        for (const r of replies)
            if (r.status === "fulfilled")
                for (const s of r.value)
                    byQid.set(s.qid, [...(byQid.get(s.qid) ?? []), s]);
        released.set(shift, byQid);
    }
    return {
        exam,
        snapshot,
        questions,
        sheets,
        released,
        beacons: await beaconsOnChain(client, exam.registry),
    };
}

/** Open the answer key for every question that appears on a sheet, then score every sheet. */
export async function computeResults(
    records: ExamRecords,
    store: StoreClient,
    drand: BeaconSource,
): Promise<{
    results: Result[];
    answerKey: Map<Hex, number>;
    root: Hex | null;
}> {
    const cfg = records.exam.config;
    if (records.snapshot.latestRound < cfg.answersRound)
        throw new Error("answers have not unlocked on chain yet");
    const beacon = await drand.get(cfg.answersRound);
    if (!beacon) throw new Error("answers beacon unavailable");
    const info = chainInfoFromConfig(cfg);
    const answerKey = new Map<Hex, number>();
    const needed = new Set(
        records.sheets.flatMap((s) =>
            s.sheets.flatMap((x) => x.sheet.answers.map(([qid]) => qid)),
        ),
    );
    for (const qid of needed) {
        const q = records.questions.get(qid);
        if (!q) continue;
        const shares =
            records.released
                .get(q.leaf.shift)
                ?.get(qid)
                ?.map((s) => s.shareA) ?? [];
        const bundle = await store.bundle(q.leaf.bundleHash);
        const ans = await openAnswer(
            bundle,
            q.leaf,
            beacon,
            info,
            shares,
            cfg.threshold,
        );
        answerKey.set(qid, ans.correct);
    }
    const marks = { correct: cfg.marksCorrect, wrong: cfg.marksWrong };
    const results = records.sheets
        .flatMap((s) => s.sheets.map((x) => scoreSheet(x, answerKey, marks)))
        .sort((a, b) => (a.candidateHash < b.candidateHash ? -1 : 1));
    return {
        results,
        answerKey,
        root: results.length ? merkleRoot(results.map(resultLeaf)) : null,
    };
}

export interface Check {
    name: string;
    ok: boolean;
    detail: string;
}

/**
 * Recompute everything from public data and report each property. Anyone can run this:
 * it needs only the chain, the store, and the custodians' post-exam share release.
 */
export async function auditExam(
    records: ExamRecords,
    store: StoreClient,
    drand: BeaconSource,
): Promise<Check[]> {
    const { exam, snapshot, questions } = records;
    const cfg = exam.config;
    const info = chainInfoFromConfig(cfg);
    const checks: Check[] = [];
    const check = (name: string, ok: boolean, detail: string) =>
        checks.push({ name, ok, detail });

    check(
        "Config hash",
        configHash(cfg) === exam.configHash,
        "the frozen config hashes to the on-chain value",
    );
    check(
        "drand key encodings agree",
        publicKeyToEip2537(cfg.drand.publicKey) ===
            cfg.drand.publicKeyG2.toLowerCase(),
        "the tlock key and the contract's verification key are the same key",
    );

    const eligible = snapshot.setters.filter((s) => s.eligible);
    check(
        "Setter batches",
        eligible.length > 0,
        `${eligible.length} of ${cfg.setters.length} setter batches acknowledged by ≥${cfg.threshold} custodians; ${questions.size} eligible questions`,
    );

    const missing = snapshot.windows.filter(
        (w) => !records.beacons.has(w.start),
    ).length;
    check(
        "Start beacons on chain",
        missing === 0 && records.beacons.has(cfg.answersRound),
        `${records.beacons.size} drand beacons verified by the contract; ${missing} shift start rounds missing`,
    );

    let paperOk = true;
    let paperDetail = "";
    for (const [shift, w] of snapshot.windows.entries()) {
        const start = await drand.get(w.start);
        if (!start || !verifyBeacon(info, start)) {
            paperOk = false;
            paperDetail += `shift ${shift}: start beacon unavailable. `;
            continue;
        }
        const seed = selectionSeed(
            exam.examId,
            shift,
            signatureToEip2537(start.signature),
        );
        const plan = shiftPlan(cfg, questions, shift, seed);
        const allowed = new Set(releasedQids(plan));
        const released = records.released.get(shift);
        const custodianSets = released
            ? new Set(released.keys())
            : new Set<Hex>();
        const shiftSheets = records.sheets
            .filter((s) => s.shift === shift)
            .flatMap((s) => s.sheets);
        for (const s of shiftSheets) {
            const perPool = new Map<number, number>();
            for (const [qid] of s.sheet.answers) {
                if (!allowed.has(qid)) paperOk = false;
                if (
                    signatureToEip2537(start.signature) !==
                    records.beacons.get(w.start)?.toLowerCase()
                )
                    paperOk = false;
                const pool = questions.get(qid)?.pool ?? -1;
                perPool.set(pool, (perPool.get(pool) ?? 0) + 1);
            }
            cfg.shifts[shift]!.perPool.forEach((count, pool) => {
                if ((perPool.get(pool) ?? 0) !== count) paperOk = false;
            });
        }
        if ([...custodianSets].some((q) => !allowed.has(q))) paperOk = false;
        paperDetail += `shift ${shift}: ${shiftSheets.length} sheets, every question in the beacon's selection. `;
    }
    check("Paper selection", paperOk, paperDetail.trim() || "no shifts");

    let rosterOk = true;
    let sheetsOk = true;
    let n = 0;
    for (const group of records.sheets) {
        const alloc = await store.allocation(group.shift).catch(() => null);
        const allocRoot = snapshot.allocationRoots[group.shift];
        if (!alloc || !allocRoot || allocationTree(alloc).root !== allocRoot)
            rosterOk = false;
        const center = cfg.centers[group.center]!;
        for (const r of group.roster) {
            if (
                !sameAddress(
                    await signerOf(rosterEntryHash(r.entry), r.centerSignature),
                    center.account,
                )
            )
                rosterOk = false;
            const proof =
                alloc &&
                allocationProof(alloc, r.entry.candidateHash, group.center);
            if (
                !proof ||
                !verifyAllocation(
                    allocRoot!,
                    {
                        candidateHash: r.entry.candidateHash,
                        center: group.center,
                    },
                    proof,
                )
            )
                rosterOk = false;
        }
        const live = new Map(
            group.roster
                .filter(
                    (r) =>
                        !group.roster.some((o) =>
                            sameAddress(o.entry.replaces, r.entry.session),
                        ),
                )
                .map((r) => [r.entry.session.toLowerCase(), r.entry]),
        );
        for (const s of group.sheets) {
            n++;
            const entry = live.get(s.sheet.session.toLowerCase());
            if (!entry || entry.candidateHash !== s.sheet.candidateHash)
                sheetsOk = false;
            if (
                !sameAddress(
                    await signerOf(sheetHash(s.sheet), s.signature),
                    s.sheet.session,
                )
            )
                sheetsOk = false;
        }
    }
    check(
        "Check-ins",
        rosterOk,
        "every roster entry is center-signed and every candidate is in the on-chain allocation",
    );
    check(
        "Answer sheets",
        sheetsOk,
        `${n} sheets, each signed by the live session of its candidate; roots match the chain`,
    );

    const transfers = new Set(
        records.sheets.flatMap((g) =>
            g.roster
                .filter((r) => r.entry.replaces !== null)
                .map((r) => r.entry.session.toLowerCase()),
        ),
    );
    let receiptsOk = true;
    let early = 0;
    let count = 0;
    for (const [j, cust] of cfg.custodians.entries()) {
        for (const [shift, w] of snapshot.windows.entries()) {
            const receipts = await store.receipts(j, shift).catch(() => []);
            for (const r of receipts) {
                count++;
                if (
                    !sameAddress(
                        await signerOf(receiptHash(r.receipt), r.signature),
                        cust.account,
                    )
                )
                    receiptsOk = false;
                if (r.receipt.servedRound < w.start) early++;
                const last = transfers.has(r.receipt.session.toLowerCase())
                    ? w.end
                    : w.start + cfg.lateEntryRounds;
                if (r.receipt.servedRound > last) receiptsOk = false;
            }
        }
    }
    check(
        "Key releases",
        receiptsOk && early === 0,
        `${count} signed custodian receipts, all inside their window (late entry, or shift end for proctor transfers); ${early} before a shift's start round`,
    );

    let questionsOk = true;
    let opened = 0;
    for (const [shift, byQid] of records.released) {
        const w = snapshot.windows[shift]!;
        const tlock = await drand.get(cfg.shifts[shift]!.startRound);
        if (!tlock || w.start > snapshot.latestRound) continue;
        for (const [qid, shares] of byQid) {
            const q = questions.get(qid);
            if (!q) continue;
            const bundle = await store.bundle(q.leaf.bundleHash);
            if (bundleHash(bundle) !== q.leaf.bundleHash) questionsOk = false;
            try {
                await openQuestion(
                    bundle,
                    q.leaf,
                    tlock,
                    info,
                    shares.map((s) => s.shareQ),
                    cfg.threshold,
                );
                opened++;
            } catch {
                questionsOk = false;
            }
        }
    }
    check(
        "Released questions open to their commitments",
        questionsOk,
        `${opened} questions re-opened from public shares and matched their setter commitments`,
    );

    const { results, root } = await computeResults(records, store, drand);
    const published = await store.results().catch(() => null);
    check(
        "Results",
        !!root &&
            root === snapshot.resultRoot &&
            !!published &&
            merkleRoot(published.map(resultLeaf)) === root,
        `${results.length} results recomputed from sheets and the opened answer key; root matches the chain`,
    );
    return checks;
}
