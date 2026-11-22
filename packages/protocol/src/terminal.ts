import type { Address } from "viem";
import {
    generatePrivateKey,
    privateKeyToAccount,
    type PrivateKeyAccount,
} from "viem/accounts";
import { fromHex, fromUtf8, type Hex } from "./bytes.ts";
import type { Bundle } from "./bundle.ts";
import { openQuestion } from "./bundle.ts";
import { chainInfoFromConfig, type ExamConfig } from "./config.ts";
import {
    httpBeaconSource,
    roundTimeMs,
    signatureToEip2537,
    type Beacon,
    type BeaconSource,
} from "./drand.ts";
import { keccak } from "./hash.ts";
import { generateHpkeKeyPair, open, type HpkeKeyPair } from "./hpke.ts";
import {
    candidateHash,
    GENESIS_LOG,
    logEntryHash,
    receiptHash,
    rosterEntryHash,
    sameAddress,
    sheetHash,
    signerOf,
    signHash,
    type AllocationProof,
    type LogEntry,
    type ReleaseReply,
    type RosterEntry,
    type ShareItem,
    type Sheet,
} from "./session.ts";
import { optionOrder, questionOrder, selectionSeed } from "./shuffle.ts";
import { shiftPlan, type EligibleQuestion } from "./state.ts";
import { getJson, HttpError, postJson } from "./store-client.ts";

export interface GatewayExam {
    registry: Address;
    chainId: number;
    examId: Hex;
    configHash: Hex;
    config: ExamConfig;
    center: { index: number; name: string; account: Address };
    windows: { start: number; end: number }[];
    latestRound: number;
    drandRound: number;
    sealed: boolean;
    ready: boolean;
    allocated: number[];
}

export interface PaperItem {
    qid: Hex;
    pool: number;
    text: string;
    /** Options in the order this candidate sees them. */
    options: string[];
    /** display index -> canonical option index */
    optionMap: number[];
    image?: { mime: string; data: string };
}

export interface Paper {
    shift: number;
    seed: Hex;
    items: PaperItem[];
    /** Questions skipped because they did not open to their commitment. */
    skipped: Hex[];
    custodiansAnswered: number[];
}

export interface CheckIn {
    entry: RosterEntry;
    centerSignature: Hex;
    allocation: AllocationProof;
}

/**
 * One candidate's session on one terminal. Holds the session keys, unlocks the paper
 * at the start beacon, keeps the hash-chained answer log, and signs the final sheet.
 * Used by the browser exam client and by the headless end-to-end test alike.
 */
export class TerminalSession {
    readonly account: PrivateKeyAccount;
    readonly candidate: Hex;
    readonly beacons: BeaconSource;
    readonly base: string;
    readonly exam: GatewayExam;
    readonly shift: number;
    readonly terminalId: string;
    checkIn?: CheckIn;
    paper?: Paper;
    readonly answers = new Map<Hex, number | null>();
    #hpke: HpkeKeyPair;
    #log: LogEntry[] = [];
    #unsent: LogEntry[] = [];

    private constructor(
        base: string,
        exam: GatewayExam,
        shift: number,
        terminalId: string,
        candidate: Hex,
        hpke: HpkeKeyPair,
    ) {
        this.base = base;
        this.exam = exam;
        this.shift = shift;
        this.terminalId = terminalId;
        this.account = privateKeyToAccount(generatePrivateKey());
        this.candidate = candidate;
        this.#hpke = hpke;
        this.beacons = httpBeaconSource(
            `${base}/api/drand`,
            chainInfoFromConfig(exam.config),
        );
    }

    static exam(base: string): Promise<GatewayExam> {
        return getJson<GatewayExam>(`${base}/api/exam`);
    }

    static async start(
        base: string,
        shift: number,
        terminalId: string,
        rollNo: string,
        checkInCode: string,
    ): Promise<TerminalSession> {
        const exam = await TerminalSession.exam(base);
        const session = new TerminalSession(
            base,
            exam,
            shift,
            terminalId,
            candidateHash(exam.examId, rollNo, checkInCode),
            await generateHpkeKeyPair(),
        );
        session.checkIn = await postJson<CheckIn>(`${base}/api/checkin`, {
            shift,
            candidateHash: session.candidate,
            terminalId,
            session: session.account.address,
            sessionHpke: session.#hpke.publicKey,
        });
        return session;
    }

    get window() {
        const w = this.exam.windows[this.shift];
        if (!w) throw new Error(`no shift ${this.shift}`);
        return w;
    }

    startTimeMs(): number {
        return roundTimeMs(
            chainInfoFromConfig(this.exam.config),
            this.window.start,
        );
    }

    endTimeMs(): number {
        return roundTimeMs(
            chainInfoFromConfig(this.exam.config),
            this.window.end,
        );
    }

    /** Poll the relayed drand beacon (verified here) until `round` exists. */
    async waitForRound(round: number, signal?: AbortSignal): Promise<Beacon> {
        const periodMs = this.exam.config.drand.period * 1000;
        for (;;) {
            if (signal?.aborted) throw new Error("aborted");
            const b = await this.beacons.get(round).catch(() => null);
            if (b) return b;
            await new Promise((r) =>
                setTimeout(r, Math.min(1000, periodMs / 2)),
            );
        }
    }

    async latestRound(): Promise<number> {
        return (await this.beacons.latest()).round;
    }

    /**
     * The only moment the paper exists. Compute the selection from the start beacon,
     * collect custodian shares sealed to this session, open each question, verify it
     * against its commitment, and order it for this candidate.
     */
    async unlock(): Promise<Paper> {
        if (!this.checkIn) throw new Error("not checked in");
        const cfg = this.exam.config;
        const info = chainInfoFromConfig(cfg);
        const start = await this.waitForRound(this.window.start);
        const original = cfg.shifts[this.shift]!.startRound;
        const tlockBeacon =
            original === start.round
                ? start
                : await this.waitForRound(original);
        const seed = selectionSeed(
            this.exam.examId,
            this.shift,
            signatureToEip2537(start.signature),
        );

        const eligible = new Map(
            (
                await getJson<EligibleQuestion[]>(
                    `${this.base}/api/questions/${this.shift}`,
                )
            ).map((q) => [q.qid, q]),
        );
        const plan = shiftPlan(cfg, eligible, this.shift, seed);

        const request = { ...this.checkIn, beacon: start };
        const replies = await Promise.allSettled(
            cfg.custodians.map((_, j) =>
                postJson<ReleaseReply>(
                    `${this.base}/api/release/${j}`,
                    request,
                ),
            ),
        );
        const shares = new Map<Hex, Hex[]>();
        const answered: number[] = [];
        const refusals: string[] = [];
        const aad = fromHex(rosterEntryHash(this.checkIn.entry));
        for (const [j, r] of replies.entries()) {
            if (r.status === "rejected") {
                refusals.push(
                    `custodian ${j}: ${r.reason instanceof HttpError ? r.reason.body : String(r.reason)}`,
                );
                continue;
            }
            const reply = r.value;
            const signer = await signerOf(
                receiptHash(reply.receipt),
                reply.signature,
            );
            if (
                !sameAddress(signer, cfg.custodians[j]!.account) ||
                reply.receipt.session !== this.account.address
            ) {
                refusals.push(`custodian ${j}: bad receipt`);
                continue;
            }
            const items = JSON.parse(
                fromUtf8(await open(this.#hpke.privateKey, reply.sealed, aad)),
            ) as ShareItem[];
            for (const it of items)
                shares.set(it.qid, [...(shares.get(it.qid) ?? []), it.share]);
            answered.push(j);
        }
        if (answered.length < cfg.threshold)
            throw new Error(
                `only ${answered.length} of ${cfg.threshold} custodians released keys. ${refusals.join("; ")}`,
            );

        const chosen: {
            qid: Hex;
            pool: number;
            payload: Awaited<ReturnType<typeof openQuestion>>;
        }[] = [];
        const skipped: Hex[] = [];
        const opened = new Map(
            await Promise.all(
                plan
                    .flatMap((pool) => pool.candidates)
                    .map(async (qid) => {
                        const q = eligible.get(qid)!;
                        try {
                            const bundle = await getJson<Bundle>(
                                `${this.base}/api/bundles/${q.leaf.bundleHash}`,
                            );
                            return [
                                qid,
                                await openQuestion(
                                    bundle,
                                    q.leaf,
                                    tlockBeacon,
                                    info,
                                    shares.get(qid) ?? [],
                                    cfg.threshold,
                                ),
                            ] as const;
                        } catch {
                            return [qid, null] as const;
                        }
                    }),
            ),
        );
        for (const pool of plan) {
            let taken = 0;
            for (const qid of pool.candidates) {
                if (taken === pool.count) break;
                const payload = opened.get(qid);
                if (!payload) {
                    skipped.push(qid);
                    continue;
                }
                chosen.push({ qid, pool: pool.pool, payload });
                taken++;
            }
        }
        const byQid = new Map(chosen.map((c) => [c.qid, c]));
        const items = questionOrder(
            seed,
            this.candidate,
            chosen.map((c) => c.qid),
        ).map((qid) => {
            const c = byQid.get(qid)!;
            const map = optionOrder(
                seed,
                this.candidate,
                qid,
                c.payload.options.length,
            );
            const item: PaperItem = {
                qid,
                pool: c.pool,
                text: c.payload.text,
                options: map.map((i) => c.payload.options[i]!),
                optionMap: map,
            };
            if (c.payload.image) item.image = c.payload.image;
            return item;
        });
        for (const it of items)
            if (!this.answers.has(it.qid)) this.answers.set(it.qid, null);
        this.paper = {
            shift: this.shift,
            seed,
            items,
            skipped,
            custodiansAnswered: answered,
        };
        return this.paper;
    }

    /** Record a choice by display position. Stored as the canonical option index. */
    answer(qid: Hex, displayIndex: number | null, round: number): void {
        const item = this.paper?.items.find((i) => i.qid === qid);
        if (!item) throw new Error("not on this paper");
        const choice =
            displayIndex === null ? null : item.optionMap[displayIndex]!;
        this.answers.set(qid, choice);
        const prev = this.#log.length
            ? logEntryHash(this.#log[this.#log.length - 1]!)
            : GENESIS_LOG;
        const entry: LogEntry = {
            seq: this.#log.length,
            prev,
            qid,
            choice,
            round,
        };
        this.#log.push(entry);
        this.#unsent.push(entry);
    }

    displayChoice(qid: Hex): number | null {
        const item = this.paper?.items.find((i) => i.qid === qid);
        const choice = this.answers.get(qid);
        if (!item || choice === null || choice === undefined) return null;
        return item.optionMap.indexOf(choice);
    }

    /** Push unsent log entries to the gateway backup. Safe to call often. */
    async flush(): Promise<void> {
        if (!this.#unsent.length) return;
        const batch = this.#unsent.splice(0);
        try {
            await postJson(`${this.base}/api/log`, {
                session: this.account.address,
                entries: batch,
            });
        } catch (e) {
            this.#unsent.unshift(...batch);
            throw e;
        }
    }

    /** After a terminal swap: replay the previous session's log so no answer is lost. */
    async restore(): Promise<number> {
        const entries = await getJson<LogEntry[]>(
            `${this.base}/api/log/${this.shift}/${this.candidate}`,
        );
        for (const e of entries)
            if (this.answers.has(e.qid)) this.answers.set(e.qid, e.choice);
        return entries.length;
    }

    get logHead(): Hex {
        return this.#log.length
            ? logEntryHash(this.#log[this.#log.length - 1]!)
            : GENESIS_LOG;
    }

    async submit(
        round: number,
    ): Promise<{ sheetHash: Hex; receiptCode: string }> {
        await this.flush().catch(() => undefined);
        const sheet: Sheet = {
            examId: this.exam.examId,
            shift: this.shift,
            center: this.exam.center.index,
            candidateHash: this.candidate,
            session: this.account.address,
            answers: [...this.answers.entries()].sort(([a], [b]) =>
                a < b ? -1 : 1,
            ),
            logHead: this.logHead,
            submittedRound: round,
        };
        const signature = await signHash(this.account, sheetHash(sheet));
        return postJson(`${this.base}/api/submit`, { sheet, signature });
    }
}

export const watermark = (s: TerminalSession, rollNo: string): string =>
    `${rollNo.toUpperCase()} · ${s.terminalId} · ${s.exam.center.name} · ${keccak(s.account.address).slice(2, 8)}`;
