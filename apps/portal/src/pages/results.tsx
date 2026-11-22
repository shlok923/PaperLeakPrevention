import { useRef, useState, type FormEvent } from "react";
import {
    candidateHash,
    getJson,
    HttpError,
    loadEligible,
    MerkleTree,
    openAnswer,
    openQuestion,
    optionOrder,
    questionOrder,
    shiftPlan,
    receiptCode,
    responseLeaf,
    resultLeaf,
    sameAddress,
    selectionSeed,
    sheetHash,
    signatureToEip2537,
    signerOf,
    verifyMerkleProof,
    type Hex,
    type ReleasedShare,
    type Result,
    type SignedSheet,
} from "@eplp/protocol";
import { describeError, type Refusal } from "../errors.ts";
import { useExam, type Exam, type Live } from "../exam.tsx";
import { plural } from "../format.ts";
import { shiftName } from "../timeline.ts";
import { Glyph, Hash, PageHead, RefusalNote, type State } from "../ui.tsx";

interface Proof {
    name: string;
    ok: boolean;
    detail: string;
}

interface Found {
    candidate: Hex;
    result: Result;
    sheet: SignedSheet;
    center: number;
    proofs: Proof[];
    receipt: string;
}

type Lookup =
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "unpublished" }
    | { kind: "unknown" }
    | { kind: "found"; found: Found }
    | { kind: "failed"; refusal: Refusal };

interface AnswerRow {
    qid: Hex;
    pool: string;
    text: string;
    options: string[];
    chosen: number | null;
    correct: number;
}

type Answers =
    | { kind: "loading" }
    | { kind: "ready"; rows: AnswerRow[] }
    | { kind: "failed"; refusal: Refusal };

async function findCandidate(
    exam: Exam,
    live: Live,
    candidate: Hex,
): Promise<Lookup> {
    const chainRoot = live.snapshot.resultRoot;
    if (!chainRoot) return { kind: "unpublished" };
    const results = await exam.store.results().catch((e: unknown) => {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
    });
    if (!results) return { kind: "unpublished" };
    const index = results.findIndex((r) => r.candidateHash === candidate);
    if (index < 0) return { kind: "unknown" };
    const result = results[index]!;

    const resultTree = new MerkleTree(results.map(resultLeaf));
    const resultIncluded = verifyMerkleProof(
        chainRoot,
        resultLeaf(result),
        resultTree.proof(index),
        results.length,
    );

    for (const posting of live.postings.filter(
        (p) => p.shift === result.shift,
    )) {
        const sheets = await exam.store
            .sheets(posting.center, posting.shift)
            .catch(() => [] as SignedSheet[]);
        const at = sheets.findIndex((s) => s.sheet.candidateHash === candidate);
        if (at < 0) continue;
        const sheet = sheets[at]!;
        const hash = sheetHash(sheet.sheet);
        const leaves = sheets.map((s) =>
            responseLeaf(s.sheet.candidateHash, sheetHash(s.sheet)),
        );
        const inRoot = verifyMerkleProof(
            posting.responseRoot,
            leaves[at]!,
            new MerkleTree(leaves).proof(at),
            leaves.length,
        );
        const signedBySession = sameAddress(
            await signerOf(hash, sheet.signature),
            sheet.sheet.session,
        );
        const center = exam.info.config.centers[posting.center]!.name;
        const proofs: Proof[] = [
            {
                name: "Your sheet is in the response root on chain",
                ok: inRoot,
                detail: `${center} posted it for ${shiftName(posting.shift)}: root ${posting.responseRoot.slice(0, 12)}…, ${plural(sheets.length, "sheet")}.`,
            },
            {
                name: "Your sheet carries your exam session's signature",
                ok: signedBySession,
                detail: `Signed by session ${sheet.sheet.session.slice(0, 10)}…, the key your terminal made at check-in.`,
            },
            {
                name: "Your score is computed from this exact sheet",
                ok: result.sheetHash === hash,
                detail: `The result names sheet ${result.sheetHash.slice(0, 12)}…`,
            },
            {
                name: "Your result is in the result root on chain",
                ok: resultIncluded,
                detail: `Leaf ${index + 1} of ${results.length} under root ${chainRoot.slice(0, 12)}…`,
            },
        ];
        return {
            kind: "found",
            found: {
                candidate,
                result,
                sheet,
                center: posting.center,
                proofs,
                receipt: receiptCode(hash),
            },
        };
    }
    return {
        kind: "failed",
        refusal: {
            code: null,
            message:
                "Your result exists, but no center's posted sheets include your sheet.",
        },
    };
}

async function openAnswers(
    exam: Exam,
    live: Live,
    f: Found,
): Promise<AnswerRow[]> {
    const cfg = exam.info.config;
    const shift = f.result.shift;
    const w = live.snapshot.windows[shift]!;
    const [start, tlock, answers] = await Promise.all([
        exam.beacons.get(w.start),
        exam.beacons.get(cfg.shifts[shift]!.startRound),
        exam.beacons.get(cfg.answersRound),
    ]);
    if (!start || !tlock || !answers)
        throw new Error("A beacon this needs is not available from drand yet.");
    const { questions } = await loadEligible(
        cfg,
        live.snapshot,
        exam.store.manifest,
    );
    const released = await Promise.all(
        exam.dep.custodianUrls.map((u) =>
            getJson<ReleasedShare[]>(`${u}/released/${shift}`).catch(() => []),
        ),
    );
    const shares = new Map<Hex, ReleasedShare[]>();
    for (const list of released)
        for (const s of list)
            shares.set(s.qid, [...(shares.get(s.qid) ?? []), s]);

    const seed = selectionSeed(
        exam.info.examId,
        shift,
        signatureToEip2537(start.signature),
    );
    const chosen = new Map(f.sheet.sheet.answers);
    const qids = shiftPlan(cfg, questions, shift, seed).flatMap((p) =>
        p.candidates.filter((q) => chosen.has(q)),
    );
    if (qids.length !== chosen.size)
        throw new Error(
            "The sheet holds a question outside this shift's selection.",
        );
    const rows: AnswerRow[] = [];
    for (const qid of questionOrder(seed, f.candidate, qids)) {
        const q = questions.get(qid);
        if (!q)
            throw new Error(
                `Question ${qid.slice(0, 10)}… is not in any eligible setter's manifest.`,
            );
        const bundle = await exam.store.bundle(q.leaf.bundleHash);
        const s = shares.get(qid) ?? [];
        const payload = await openQuestion(
            bundle,
            q.leaf,
            tlock,
            exam.drand,
            s.map((x) => x.shareQ),
            cfg.threshold,
        );
        const answer = await openAnswer(
            bundle,
            q.leaf,
            answers,
            exam.drand,
            s.map((x) => x.shareA),
            cfg.threshold,
        );
        const order = optionOrder(
            seed,
            f.candidate,
            qid,
            payload.options.length,
        );
        const pick = chosen.get(qid) ?? null;
        rows.push({
            qid,
            pool: cfg.pools[q.pool] ?? "",
            text: payload.text,
            options: order.map((i) => payload.options[i]!),
            chosen: pick === null ? null : order.indexOf(pick),
            correct: order.indexOf(answer.correct),
        });
    }
    return rows;
}

export function ResultsPage() {
    const { exam, live } = useExam();
    const cfg = exam.info.config;
    const [roll, setRoll] = useState("");
    const [code, setCode] = useState("");
    const [errors, setErrors] = useState<{ roll?: string; code?: string }>({});
    const [lookup, setLookup] = useState<Lookup>({ kind: "idle" });
    const [answers, setAnswers] = useState<Answers | null>(null);
    const request = useRef(0);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const errs = {
            ...(roll.trim()
                ? {}
                : { roll: "Write the roll number from your admit card" }),
            ...(code.trim()
                ? {}
                : { code: "Write the check-in code from your admit card" }),
        };
        setErrors(errs);
        if (errs.roll || errs.code) {
            document.getElementById(errs.roll ? "roll" : "code")?.focus();
            return;
        }
        const id = ++request.current;
        const current = () => id === request.current;
        setLookup({ kind: "checking" });
        setAnswers(null);
        try {
            const l = await findCandidate(
                exam,
                live,
                candidateHash(exam.info.examId, roll, code),
            );
            if (!current()) return;
            setLookup(l);
            if (l.kind === "found") {
                setAnswers({ kind: "loading" });
                openAnswers(exam, live, l.found)
                    .then(
                        (rows) =>
                            current() && setAnswers({ kind: "ready", rows }),
                    )
                    .catch(
                        (err: unknown) =>
                            current() &&
                            setAnswers({
                                kind: "failed",
                                refusal: describeError(err),
                            }),
                    );
            }
        } catch (err) {
            if (current())
                setLookup({ kind: "failed", refusal: describeError(err) });
        }
    };

    return (
        <div className="page">
            <div className="wrap">
                <PageHead
                    title="Check your exam result"
                    lead="Your roll number and check-in code make a hash; only that hash is on chain. This page finds your sheet and score and proves both against the on-chain roots."
                />
                <div className="grid grid--top desk">
                    <form
                        className="form span-4 lookup"
                        noValidate
                        onSubmit={(e) => void submit(e)}
                    >
                        <div className="field field--full">
                            <label htmlFor="roll">Roll number</label>
                            <input
                                id="roll"
                                autoComplete="off"
                                value={roll}
                                onChange={(e) => setRoll(e.target.value)}
                                aria-invalid={errors.roll ? true : undefined}
                                aria-describedby={
                                    errors.roll ? "roll-error" : undefined
                                }
                            />
                            {errors.roll ? (
                                <span className="field__error" id="roll-error">
                                    {errors.roll}
                                </span>
                            ) : null}
                        </div>
                        <div className="field field--full">
                            <label htmlFor="code">Check-in code</label>
                            <input
                                id="code"
                                autoComplete="off"
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                aria-invalid={errors.code ? true : undefined}
                                aria-describedby={
                                    errors.code ? "code-error" : undefined
                                }
                            />
                            {errors.code ? (
                                <span className="field__error" id="code-error">
                                    {errors.code}
                                </span>
                            ) : null}
                        </div>
                        <div className="btn-row">
                            <button
                                type="submit"
                                className="btn btn--primary"
                                disabled={lookup.kind === "checking"}
                            >
                                Check my result
                            </button>
                        </div>
                        <p className="form__status" role="status">
                            {lookup.kind === "checking"
                                ? "Checking the roots"
                                : ""}
                        </p>
                        <p className="note">
                            Nothing you type leaves this browser. The page
                            fetches the public results and does every check
                            here.
                        </p>
                    </form>
                    <div className="span-8">
                        {lookup.kind === "unpublished" ? (
                            <p className="notice">
                                Results are not published yet. The answer key
                                opens at round {cfg.answersRound}, and the
                                authority publishes after that.
                            </p>
                        ) : lookup.kind === "unknown" ? (
                            <p className="notice" role="alert">
                                No result matches this roll number and check-in
                                code. Check both against your admit card; the
                                code is six letters and digits.
                            </p>
                        ) : lookup.kind === "failed" ? (
                            <RefusalNote
                                refusal={lookup.refusal}
                                title="The check could not finish"
                            />
                        ) : lookup.kind === "found" ? (
                            <ResultView
                                found={lookup.found}
                                answers={answers}
                                marks={{
                                    correct: cfg.marksCorrect,
                                    wrong: cfg.marksWrong,
                                }}
                            />
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}

function ResultView({
    found,
    answers,
    marks,
}: {
    found: Found;
    answers: Answers | null;
    marks: { correct: number; wrong: number };
}) {
    const r = found.result;
    const recount =
        answers?.kind === "ready"
            ? answers.rows.reduce(
                  (n, row) =>
                      row.chosen === null
                          ? { ...n, blank: n.blank + 1 }
                          : row.chosen === row.correct
                            ? { ...n, right: n.right + 1 }
                            : { ...n, wrong: n.wrong + 1 },
                  { right: 0, wrong: 0, blank: 0 },
              )
            : null;
    const recountOk = recount
        ? recount.right === r.correct &&
          recount.wrong === r.wrong &&
          recount.blank === r.unanswered
        : null;
    const proofs: Proof[] = [
        ...found.proofs,
        ...(recount
            ? [
                  {
                      name: "The score matches your answers and the answer key",
                      ok: !!recountOk,
                      detail: `${r.correct} right, ${r.wrong} wrong, ${r.unanswered} blank, recomputed here.`,
                  },
              ]
            : []),
    ];
    return (
        <div className="stack-6 result">
            <div className="result__top">
                <div className="score">
                    <p className="t-label muted">Score, {shiftName(r.shift)}</p>
                    <p className="score__value">{r.score}</p>
                    <p className="score__line">
                        {r.correct} right × {marks.correct}, {r.wrong} wrong ×{" "}
                        {marks.wrong}, {r.unanswered} blank
                    </p>
                </div>
                <div className="receipt">
                    <p className="t-label muted">Receipt code</p>
                    <p className="receipt__code">{found.receipt}</p>
                    <p className="receipt__line">
                        Compare it with the code your terminal showed when you
                        submitted. A different code means your sheet was
                        changed.
                    </p>
                </div>
            </div>
            <ul className="proofs" aria-label="Checks against the chain">
                {proofs.map((p) => (
                    <li
                        key={p.name}
                        className={`proofs__row is-${p.ok ? "done" : "failed"}`}
                    >
                        <Glyph state={p.ok ? "done" : "failed"} />
                        <div>
                            <p className="proofs__name">{p.name}</p>
                            <p className="proofs__detail">{p.detail}</p>
                        </div>
                    </li>
                ))}
                {answers?.kind === "loading" ? (
                    <li className="proofs__row is-active">
                        <Glyph state="active" />
                        <div>
                            <p className="proofs__name">
                                Opening your questions and the answer key
                            </p>
                            <p className="proofs__detail">
                                From the custodians' public shares and the drand
                                beacons, in this browser.
                            </p>
                        </div>
                    </li>
                ) : null}
            </ul>
            {answers?.kind === "failed" ? (
                <RefusalNote
                    refusal={answers.refusal}
                    title="Your questions could not be opened"
                />
            ) : null}
            {answers?.kind === "ready" ? (
                <AnswerList rows={answers.rows} />
            ) : null}
            <p className="note">
                Candidate hash <Hash value={found.candidate} />
            </p>
        </div>
    );
}

const LETTERS = ["A", "B", "C", "D", "E", "F"];

function AnswerList({ rows }: { rows: AnswerRow[] }) {
    return (
        <div className="answers">
            <h2 className="box-title">
                Your answers against the key, in the order you saw them
            </h2>
            <ol className="answers__list">
                {rows.map((row, i) => {
                    const state: State =
                        row.chosen === null
                            ? "waiting"
                            : row.chosen === row.correct
                              ? "done"
                              : "failed";
                    return (
                        <li
                            key={row.qid}
                            className={`answer is-${state}`}
                            data-qid={row.qid}
                        >
                            <div className="answer__head">
                                <span className="t-label muted">
                                    Question {i + 1}, {row.pool}
                                </span>
                                <span className={`state state--${state}`}>
                                    {state === "done"
                                        ? "Right"
                                        : state === "failed"
                                          ? "Wrong"
                                          : "Blank"}
                                </span>
                            </div>
                            <p className="answer__text">{row.text}</p>
                            <ul className="answer__options">
                                {row.options.map((o, k) => (
                                    <li
                                        key={k}
                                        className={
                                            [
                                                k === row.correct
                                                    ? "is-key"
                                                    : "",
                                                k === row.chosen
                                                    ? "is-chosen"
                                                    : "",
                                            ]
                                                .join(" ")
                                                .trim() || undefined
                                        }
                                    >
                                        <span className="answer__letter">
                                            {LETTERS[k]}
                                        </span>
                                        <span>{o}</span>
                                        {k === row.chosen ? (
                                            <span className="answer__tag">
                                                Your answer
                                            </span>
                                        ) : null}
                                        {k === row.correct ? (
                                            <span className="answer__tag answer__tag--key">
                                                Key
                                            </span>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
