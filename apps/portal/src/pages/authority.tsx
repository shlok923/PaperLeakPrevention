import { useState, type FormEvent } from "react";
import {
    allocationTree,
    candidateHash,
    computeResults,
    randomBytes,
    roundTimeMs,
    send,
    type Allocation,
    type Hex,
    type Result,
} from "@eplp/protocol";
import { describeError, type Refusal } from "../errors.ts";
import { useExam } from "../exam.tsx";
import { clock, plural } from "../format.ts";
import { roleLabel, useIdentity, type Signer } from "../identity.tsx";
import { shiftName } from "../timeline.ts";
import { Hash, PageHead, RefusalNote, Steps, type StepItem } from "../ui.tsx";
import { collectReleased } from "../records.ts";
import { CreateExamDesk } from "./create-exam.tsx";

export function AuthorityPage() {
    const { exam } = useExam();
    const { signer } = useIdentity();
    const isAuthority = signer?.role.kind === "authority";
    return (
        <div className="page">
            <div className="wrap">
                <PageHead
                    title="Run the exam as its authority"
                    lead="Create an exam, allocate candidates, move a shift later, revoke a center and publish results. Nothing here reads a question or touches the selection."
                >
                    {isAuthority ? (
                        <nav className="page-index" aria-label="On this page">
                            <a href="#allocation">Allocation</a>
                            <a href="#schedule">Schedule</a>
                            <a href="#centers">Centers</a>
                            <a href="#publish">Results</a>
                            <a href="#create">New exam</a>
                        </nav>
                    ) : null}
                </PageHead>
                {!signer ? (
                    <p className="notice">
                        Sign in with the authority's account from the top bar.
                        Any account may create a new exam, and becomes its
                        authority.
                    </p>
                ) : !isAuthority ? (
                    <p className="notice">
                        You are signed in as {roleLabel(exam.info, signer.role)}
                        . Running this exam needs the authority's account,{" "}
                        {exam.info.authority}. You can still create a new exam
                        below; your account becomes its authority.
                    </p>
                ) : null}
                {signer && isAuthority ? (
                    <>
                        <AllocationDesk signer={signer} />
                        <ScheduleDesk signer={signer} />
                        <CentersDesk signer={signer} />
                        <PublishDesk signer={signer} />
                    </>
                ) : null}
                {signer ? <CreateExamDesk signer={signer} /> : null}
            </div>
        </div>
    );
}

type Action =
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "done"; hash: Hex }
    | { kind: "refused"; refusal: Refusal };

function ActionResult({ action, done }: { action: Action; done: string }) {
    if (action.kind === "refused")
        return (
            <RefusalNote
                refusal={action.refusal}
                title="The contract refused"
            />
        );
    if (action.kind === "done")
        return (
            <p className="ok-line" role="status">
                {done} in transaction <Hash value={action.hash} />
            </p>
        );
    return null;
}

export interface AdmitCard {
    rollNo: string;
    checkInCode: string;
    shift: number;
    center: number;
    centerName: string;
    startRound: number;
    startsAt: string;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () =>
    [...randomBytes(6)]
        .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
        .join("");
const rollsOf = (text: string) =>
    text
        .split(/[\s,;]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
const cardsKey = (registry: string) =>
    `eplp.admit-cards.${registry.toLowerCase()}`;

function savedCards(registry: string): AdmitCard[] | null {
    try {
        const v = sessionStorage.getItem(cardsKey(registry));
        return v ? (JSON.parse(v) as AdmitCard[]) : null;
    } catch {
        return null;
    }
}

function saveCards(registry: string, cards: AdmitCard[]): void {
    try {
        sessionStorage.setItem(cardsKey(registry), JSON.stringify(cards));
    } catch {
        // storage blocked
    }
}

function download(name: string, type: string, body: string): void {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}

function AllocationDesk({ signer }: { signer: Signer }) {
    const { exam, live, refresh } = useExam();
    const cfg = exam.info.config;
    const [rolls, setRolls] = useState<string[][]>(() =>
        cfg.shifts.map(() => cfg.centers.map(() => "")),
    );
    const [perCenter, setPerCenter] = useState("4");
    const [problem, setProblem] = useState<string | null>(null);
    const [cards, setCards] = useState<AdmitCard[] | null>(() =>
        savedCards(exam.info.registry),
    );
    const [posting, setPosting] = useState<Action[]>(() =>
        cfg.shifts.map(() => ({ kind: "idle" })),
    );

    const fill = () => {
        const n = Math.max(
            1,
            Math.min(500, Math.floor(Number(perCenter)) || 1),
        );
        setRolls(
            cfg.shifts.map((_, s) =>
                cfg.centers.map((_, c) =>
                    Array.from(
                        { length: n },
                        (_, k) =>
                            `NET26${s}${c}${String(k + 1).padStart(3, "0")}`,
                    ).join("\n"),
                ),
            ),
        );
    };

    const makeCards = () => {
        const seen = new Set<string>();
        const out: AdmitCard[] = [];
        for (const [shift, perShift] of rolls.entries()) {
            const w = live.snapshot.windows[shift]!;
            for (const [center, text] of perShift.entries()) {
                for (const rollNo of rollsOf(text)) {
                    if (seen.has(rollNo))
                        return setProblem(
                            `Roll number ${rollNo} appears twice. Each candidate sits one shift at one center.`,
                        );
                    seen.add(rollNo);
                    out.push({
                        rollNo,
                        checkInCode: newCode(),
                        shift,
                        center,
                        centerName: cfg.centers[center]!.name,
                        startRound: w.start,
                        startsAt: new Date(
                            roundTimeMs(exam.drand, w.start),
                        ).toISOString(),
                    });
                }
            }
        }
        if (!out.length)
            return setProblem(
                "Add at least one roll number, or fill them in with the button above.",
            );
        setProblem(null);
        setCards(out);
        saveCards(exam.info.registry, out);
        setPosting(cfg.shifts.map(() => ({ kind: "idle" })));
    };

    const allocationFor = (shift: number): Allocation => ({
        examId: exam.info.examId,
        shift,
        entries: (cards ?? [])
            .filter((c) => c.shift === shift)
            .map((c) => ({
                candidateHash: candidateHash(
                    exam.info.examId,
                    c.rollNo,
                    c.checkInCode,
                ),
                center: c.center,
            })),
    });

    const post = async (shift: number) => {
        const allocation = allocationFor(shift);
        setPosting((p) =>
            p.map((a, i) => (i === shift ? { kind: "busy" } : a)),
        );
        try {
            if (!allocation.entries.length)
                throw new Error(
                    `${shiftName(shift)} has no candidates in these cards.`,
                );
            const hash = await send(
                signer.wallet,
                exam.client,
                exam.info.registry,
                "setAllocation",
                [
                    shift,
                    allocationTree(allocation).root,
                    allocation.entries.length,
                ],
            );
            await exam.store.putAllocation(allocation);
            setPosting((p) =>
                p.map((a, i) => (i === shift ? { kind: "done", hash } : a)),
            );
            void refresh();
        } catch (e) {
            setPosting((p) =>
                p.map((a, i) =>
                    i === shift
                        ? { kind: "refused", refusal: describeError(e) }
                        : a,
                ),
            );
        }
    };

    const csv = () =>
        [
            "roll_no,check_in_code,shift,center,starts_at",
            ...(cards ?? []).map(
                (c) =>
                    `${c.rollNo},${c.checkInCode},${c.shift + 1},"${c.centerName}",${c.startsAt}`,
            ),
        ].join("\n");

    return (
        <section
            className="desk-section"
            id="allocation"
            aria-labelledby="allocation-h"
        >
            <div className="section-head">
                <h2 id="allocation-h">Candidate allocation</h2>
                <p>
                    Only hashes of roll number and check-in code go on chain,
                    one root per shift. The codes print on admit cards; post
                    each shift before its start round.
                </p>
            </div>
            <div className="fill-row">
                <div className="field">
                    <label htmlFor="per-center">
                        Candidates per center and shift
                    </label>
                    <input
                        id="per-center"
                        inputMode="numeric"
                        value={perCenter}
                        onChange={(e) => setPerCenter(e.target.value)}
                    />
                </div>
                <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={fill}
                >
                    Fill in roll numbers
                </button>
            </div>
            <div className="roll-grid">
                {cfg.shifts.map((_, shift) =>
                    cfg.centers.map((c, center) => (
                        <div className="field" key={`${shift}-${center}`}>
                            <label htmlFor={`rolls-${shift}-${center}`}>
                                {shiftName(shift)}, {c.name}
                            </label>
                            <textarea
                                id={`rolls-${shift}-${center}`}
                                rows={5}
                                value={rolls[shift]![center]}
                                placeholder="One roll number a line"
                                onChange={(e) =>
                                    setRolls((r) =>
                                        r.map((row, s) =>
                                            s === shift
                                                ? row.map((v, k) =>
                                                      k === center
                                                          ? e.target.value
                                                          : v,
                                                  )
                                                : row,
                                        ),
                                    )
                                }
                            />
                            <span className="field__count">
                                {plural(
                                    rollsOf(rolls[shift]![center]!).length,
                                    "candidate",
                                )}
                            </span>
                        </div>
                    )),
                )}
            </div>
            <div className="btn-row">
                <button
                    type="button"
                    className="btn btn--primary"
                    onClick={makeCards}
                >
                    Create check-in codes
                </button>
            </div>
            {problem ? (
                <p className="field__error" role="alert">
                    {problem}
                </p>
            ) : null}

            {cards ? (
                <div className="cards-block">
                    <div className="post-grid">
                        {cfg.shifts.map((_, shift) => {
                            const a = posting[shift]!;
                            const allocation = allocationFor(shift);
                            const root = allocation.entries.length
                                ? allocationTree(allocation).root
                                : null;
                            const onChain =
                                live.snapshot.allocationRoots[shift];
                            const matches = !!root && onChain === root;
                            return (
                                <div className="post-card" key={shift}>
                                    <p className="post-card__title">
                                        {shiftName(shift)}:{" "}
                                        {plural(
                                            allocation.entries.length,
                                            "candidate",
                                        )}
                                    </p>
                                    <p className="muted">
                                        Starts at round{" "}
                                        {live.snapshot.windows[shift]!.start}.
                                        Root{" "}
                                        {root ? (
                                            <Hash value={root} n={4} />
                                        ) : (
                                            "none"
                                        )}
                                    </p>
                                    <p
                                        className={
                                            matches ? "ok-line" : "muted"
                                        }
                                    >
                                        {matches
                                            ? "On chain and in the store"
                                            : onChain
                                              ? "Chain holds a different root"
                                              : "Not on chain"}
                                    </p>
                                    <button
                                        type="button"
                                        className="btn btn--secondary"
                                        disabled={a.kind === "busy" || !root}
                                        onClick={() => void post(shift)}
                                    >
                                        {a.kind === "busy"
                                            ? "Posting"
                                            : `Post ${shiftName(shift)} allocation`}
                                    </button>
                                    <ActionResult action={a} done="Posted" />
                                </div>
                            );
                        })}
                    </div>
                    <div className="btn-row">
                        <button
                            type="button"
                            className="btn btn--secondary"
                            onClick={() =>
                                download(
                                    "admit-cards.json",
                                    "application/json",
                                    JSON.stringify(cards, null, 2),
                                )
                            }
                        >
                            Download admit cards
                        </button>
                        <button
                            type="button"
                            className="btn btn--secondary"
                            onClick={() =>
                                download("admit-cards.csv", "text/csv", csv())
                            }
                        >
                            Download as CSV
                        </button>
                        <button
                            type="button"
                            className="btn btn--secondary"
                            onClick={() => window.print()}
                        >
                            Print admit cards
                        </button>
                    </div>
                    <p className="note">
                        The codes live only in this browser tab until you
                        download or print them.
                    </p>
                    <AdmitCards cards={cards} />
                </div>
            ) : null}
        </section>
    );
}

function AdmitCards({ cards }: { cards: AdmitCard[] }) {
    const { exam } = useExam();
    return (
        <div className="admit-cards" aria-label="Admit cards">
            {cards.map((c) => (
                <article className="admit" key={c.rollNo}>
                    <p className="admit__exam">{exam.info.config.title}</p>
                    <dl>
                        <dt>Roll number</dt>
                        <dd className="admit__roll">{c.rollNo}</dd>
                        <dt>Check-in code</dt>
                        <dd className="admit__code">{c.checkInCode}</dd>
                        <dt>Sitting</dt>
                        <dd>
                            {shiftName(c.shift)}, {c.centerName}
                        </dd>
                        <dt>Starts</dt>
                        <dd>
                            Round {c.startRound},{" "}
                            {clock(Date.parse(c.startsAt))}
                        </dd>
                    </dl>
                </article>
            ))}
        </div>
    );
}

function ScheduleDesk({ signer }: { signer: Signer }) {
    const { exam, live, refresh } = useExam();
    const cfg = exam.info.config;
    const [shift, setShift] = useState(0);
    const w = live.snapshot.windows[shift]!;
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [action, setAction] = useState<Action>({ kind: "idle" });
    const newStart = start === "" ? w.start : Number(start);
    const newEnd = end === "" ? w.end : Number(end);
    const next = live.snapshot.windows[shift + 1];

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setAction({ kind: "busy" });
        try {
            const hash = await send(
                signer.wallet,
                exam.client,
                exam.info.registry,
                "postpone",
                [shift, BigInt(newStart), BigInt(newEnd)],
            );
            setAction({ kind: "done", hash });
            setStart("");
            setEnd("");
            void refresh();
        } catch (err) {
            setAction({ kind: "refused", refusal: describeError(err) });
        }
    };

    return (
        <section
            className="desk-section"
            id="schedule"
            aria-labelledby="schedule-h"
        >
            <div className="section-head">
                <h2 id="schedule-h">Shift schedule</h2>
                <p>
                    A shift moves later, never earlier, and only before it
                    starts. Its time-lock still opens at round{" "}
                    {cfg.shifts[shift]!.startRound}, so after that only the
                    custodians hold it shut.
                </p>
            </div>
            <form
                className="form schedule-form"
                onSubmit={(e) => void submit(e)}
            >
                <div className="field">
                    <label htmlFor="pp-shift">Shift</label>
                    <select
                        id="pp-shift"
                        value={shift}
                        onChange={(e) => (
                            setShift(Number(e.target.value)),
                            setStart(""),
                            setEnd(""),
                            setAction({ kind: "idle" })
                        )}
                    >
                        {cfg.shifts.map((_, i) => (
                            <option key={i} value={i}>
                                {shiftName(i)}, rounds{" "}
                                {live.snapshot.windows[i]!.start} to{" "}
                                {live.snapshot.windows[i]!.end}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="field">
                    <label htmlFor="pp-start">New start round</label>
                    <input
                        id="pp-start"
                        inputMode="numeric"
                        value={start}
                        placeholder={String(w.start)}
                        onChange={(e) => setStart(e.target.value)}
                    />
                    <span className="field__count">
                        {Number.isFinite(newStart)
                            ? clock(roundTimeMs(exam.drand, newStart))
                            : "Write a round number"}
                    </span>
                </div>
                <div className="field">
                    <label htmlFor="pp-end">New end round</label>
                    <input
                        id="pp-end"
                        inputMode="numeric"
                        value={end}
                        placeholder={String(w.end)}
                        onChange={(e) => setEnd(e.target.value)}
                    />
                    <span className="field__count">
                        {Number.isFinite(newEnd)
                            ? clock(roundTimeMs(exam.drand, newEnd))
                            : "Write a round number"}
                    </span>
                </div>
                <p className="rules">
                    Rules the contract checks: start at or after round {w.start}
                    ; end after the start and before round {cfg.answersRound}
                    {next
                        ? `, and no later than round ${next.start} when ${shiftName(shift + 1)} starts`
                        : ""}
                    ; drand has not reached round {w.start}.
                </p>
                <div className="btn-row">
                    <button
                        type="submit"
                        className="btn btn--secondary"
                        disabled={
                            action.kind === "busy" ||
                            !Number.isFinite(newStart) ||
                            !Number.isFinite(newEnd)
                        }
                    >
                        Postpone {shiftName(shift)}
                    </button>
                </div>
            </form>
            <ActionResult action={action} done={`${shiftName(shift)} moved`} />
        </section>
    );
}

function CentersDesk({ signer }: { signer: Signer }) {
    const { exam, live, refresh } = useExam();
    const cfg = exam.info.config;
    const [armed, setArmed] = useState<number | null>(null);
    const [action, setAction] = useState<Action>({ kind: "idle" });

    const revoke = async (center: number) => {
        setArmed(null);
        setAction({ kind: "busy" });
        try {
            const hash = await send(
                signer.wallet,
                exam.client,
                exam.info.registry,
                "revokeCenter",
                [cfg.centers[center]!.account],
            );
            setAction({ kind: "done", hash });
            void refresh();
        } catch (err) {
            setAction({ kind: "refused", refusal: describeError(err) });
        }
    };

    return (
        <section
            className="desk-section"
            id="centers"
            aria-labelledby="centers-h"
        >
            <div className="section-head">
                <h2 id="centers-h">Exam centers</h2>
                <p>
                    Revoking a center stops every custodian from releasing keys
                    to its terminals at their next check. It cannot be undone.
                </p>
            </div>
            <ul className="rows center-rows">
                {cfg.centers.map((c, i) => {
                    const revoked = live.snapshot.centerRevoked[i];
                    return (
                        <li key={c.account}>
                            <span className="rows__name">
                                {c.name} <Hash value={c.account} n={4} />
                            </span>
                            <span className="rows__value">
                                {revoked ? (
                                    <span className="state state--failed">
                                        Revoked
                                    </span>
                                ) : armed === i ? (
                                    <span className="btn-row">
                                        <button
                                            type="button"
                                            className="btn btn--secondary"
                                            onClick={() => void revoke(i)}
                                        >
                                            Confirm: revoke {c.name}
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn--secondary"
                                            onClick={() => setArmed(null)}
                                        >
                                            Keep it
                                        </button>
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        className="btn btn--secondary"
                                        disabled={action.kind === "busy"}
                                        onClick={() => setArmed(i)}
                                    >
                                        Revoke {c.name}
                                    </button>
                                )}
                            </span>
                        </li>
                    );
                })}
            </ul>
            <ActionResult action={action} done="Center revoked" />
        </section>
    );
}

type Publish =
    | { kind: "idle" }
    | { kind: "collecting"; waiting?: string }
    | { kind: "scoring"; sheets: number }
    | { kind: "signing"; root: Hex; candidates: number }
    | { kind: "uploading"; root: Hex; hash: Hex | null }
    | {
          kind: "published";
          root: Hex;
          hash: Hex | null;
          results: Result[];
          questions: number;
      }
    | { kind: "failed"; stage: string; refusal: Refusal };

function PublishDesk({ signer }: { signer: Signer }) {
    const { exam, live, refresh } = useExam();
    const cfg = exam.info.config;
    const [p, setP] = useState<Publish>({ kind: "idle" });
    const answersOpen = live.snapshot.latestRound >= cfg.answersRound;
    const chainRoot = live.snapshot.resultRoot;

    const publish = async () => {
        let stage = "collecting the records";
        try {
            setP({ kind: "collecting" });
            const records = await collectReleased(exam, (shifts) =>
                setP({
                    kind: "collecting",
                    waiting: `Waiting for the custodians to release the answer-key shares of ${shifts.map(shiftName).join(" and ")}`,
                }),
            );
            const sheets = records.sheets.reduce(
                (n, s) => n + s.sheets.length,
                0,
            );
            stage = "opening the answer key";
            setP({ kind: "scoring", sheets });
            const { results, answerKey, root } = await computeResults(
                records,
                exam.store,
                exam.beacons,
            );
            if (!root)
                throw new Error(
                    "No answer sheets were posted, so there is nothing to score.",
                );
            let hash: Hex | null = null;
            if (!records.snapshot.resultRoot) {
                stage = "sending postResults";
                setP({ kind: "signing", root, candidates: results.length });
                hash = await send(
                    signer.wallet,
                    exam.client,
                    exam.info.registry,
                    "postResults",
                    [root, results.length],
                );
            } else if (records.snapshot.resultRoot !== root) {
                throw new Error(
                    `The chain already holds result root ${records.snapshot.resultRoot}, which differs from the recomputed ${root}.`,
                );
            }
            stage = "uploading the results";
            setP({ kind: "uploading", root, hash });
            await exam.store.putResults(results);
            setP({
                kind: "published",
                root,
                hash,
                results,
                questions: answerKey.size,
            });
            void refresh();
        } catch (e) {
            setP({ kind: "failed", stage, refusal: describeError(e) });
        }
    };

    const busy =
        p.kind === "collecting" ||
        p.kind === "scoring" ||
        p.kind === "signing" ||
        p.kind === "uploading";
    const order = [
        "collecting",
        "scoring",
        "signing",
        "uploading",
        "published",
    ] as const;
    const at =
        p.kind === "idle" || p.kind === "failed" ? -1 : order.indexOf(p.kind);
    const st = (i: number): StepItem["state"] =>
        p.kind === "published" || i < at
            ? "done"
            : i === at
              ? "active"
              : "waiting";
    const steps: StepItem[] = [
        {
            key: "collect",
            state: st(0),
            title: "Collect sheets, rosters and released shares",
            detail:
                p.kind === "scoring"
                    ? plural(p.sheets, "signed sheet")
                    : p.kind === "collecting"
                      ? p.waiting
                      : undefined,
        },
        {
            key: "score",
            state: st(1),
            title: "Open the answer key and score every sheet",
        },
        {
            key: "post",
            state: st(2),
            title: "One transaction: postResults",
            detail:
                p.kind === "published" || p.kind === "uploading" ? (
                    p.hash ? (
                        <Hash value={p.hash} />
                    ) : (
                        "Root was already on chain"
                    )
                ) : undefined,
        },
        {
            key: "upload",
            state: st(3),
            title: "Publish every result to the store",
        },
    ];

    return (
        <section
            className="desk-section"
            id="publish"
            aria-labelledby="publish-h"
        >
            <div className="section-head">
                <h2 id="publish-h">Results</h2>
                <p>
                    Answer-key shares are released only after round{" "}
                    {cfg.answersRound}, when every response root is already on
                    chain. Scoring runs here, in this browser, from public
                    records.
                </p>
            </div>
            <div className="grid grid--top">
                <div className="span-6 stack-5">
                    <Steps items={steps} label="Publishing progress" />
                    <div className="btn-row">
                        <button
                            type="button"
                            className="btn btn--primary"
                            disabled={!answersOpen || busy}
                            onClick={() => void publish()}
                        >
                            {chainRoot
                                ? "Compute and upload results again"
                                : "Compute and publish results"}
                        </button>
                    </div>
                    {!answersOpen ? (
                        <p className="note">
                            The answers round {cfg.answersRound} is not on chain
                            yet (
                            {clock(roundTimeMs(exam.drand, cfg.answersRound))}).
                            The contract would answer TooEarly().
                        </p>
                    ) : null}
                    {p.kind === "failed" ? (
                        <RefusalNote
                            refusal={p.refusal}
                            title={`Stopped while ${p.stage}`}
                        />
                    ) : null}
                </div>
                <div className="span-6 stack-5">
                    {p.kind === "published" ? (
                        <div className="panel-box" role="status">
                            <h3 className="box-title">
                                {plural(p.results.length, "result")} published,{" "}
                                {p.questions} answers opened
                            </h3>
                            <p>
                                Result root <Hash value={p.root} />
                            </p>
                            <table className="table">
                                <caption className="sr-only">
                                    Published results
                                </caption>
                                <thead>
                                    <tr>
                                        <th scope="col">Candidate hash</th>
                                        <th scope="col">Shift</th>
                                        <th scope="col">Score</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {p.results.map((r) => (
                                        <tr key={r.candidateHash}>
                                            <td>
                                                <Hash
                                                    value={r.candidateHash}
                                                    n={4}
                                                />
                                            </td>
                                            <td>{shiftName(r.shift)}</td>
                                            <td>{r.score}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : chainRoot ? (
                        <div className="panel-box">
                            <h3 className="box-title">Result root on chain</h3>
                            <p>
                                <Hash value={chainRoot} />
                            </p>
                        </div>
                    ) : null}
                </div>
            </div>
        </section>
    );
}
