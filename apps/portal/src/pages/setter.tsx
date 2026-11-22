import { useEffect, useRef, useState, type DragEvent } from "react";
import {
    examRegistryAbi,
    parseQuestions,
    roundTimeMs,
    sealBatch,
    send,
    setterSlots,
    type Hex,
    type Question,
} from "@eplp/protocol";
import { describeError, type Refusal } from "../errors.ts";
import { useExam, useNow } from "../exam.tsx";
import { clock, plural, relative } from "../format.ts";
import { roleLabel, useIdentity, type Signer } from "../identity.tsx";
import { shiftName } from "../timeline.ts";
import {
    Bar,
    Dots,
    Glyph,
    Hash,
    PageHead,
    RefusalNote,
    Steps,
    type StepItem,
} from "../ui.tsx";

type SetterRole = Extract<Signer["role"], { kind: "setter" }>;

type Draft =
    | { kind: "empty" }
    | {
          kind: "invalid";
          file: string;
          general: string[];
          byQuestion: [number, string[]][];
      }
    | { kind: "ready"; file: string; questions: Question[] };

interface Tx {
    hash: Hex;
    block: bigint;
    gasUsed: bigint;
    sentByAccount: number;
}

type Run =
    | { kind: "idle" }
    | { kind: "sealing"; done: number; total: number }
    | { kind: "signing"; root: Hex }
    | { kind: "uploading"; root: Hex; tx: Tx; done: number; total: number }
    | { kind: "submitted"; root: Hex; tx: Tx }
    | {
          kind: "failed";
          stage: "sealing" | "signing" | "uploading";
          refusal: Refusal;
          root?: Hex;
          tx?: Tx;
      };

export function SetterPage() {
    const { exam } = useExam();
    const { signer } = useIdentity();
    if (!signer || signer.role.kind !== "setter")
        return (
            <div className="page">
                <div className="wrap">
                    <PageHead
                        title="Seal and submit your questions"
                        lead="Sign in as a setter to see your subject, your slots and your submission. Each setter sends exactly one transaction for the whole exam."
                    />
                    <p className="notice">
                        {signer
                            ? `You are signed in as ${roleLabel(exam.info, signer.role)}, which has no setter slots in this exam.`
                            : "Sign in from the top bar: with a browser wallet, or with a demo identity on a dev deployment."}
                    </p>
                </div>
            </div>
        );
    return (
        <SetterDesk key={signer.address} signer={signer} role={signer.role} />
    );
}

function readDraft(file: string, text: string, need: number): Draft {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return {
            kind: "invalid",
            file,
            general: [
                `The file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
            ],
            byQuestion: [],
        };
    }
    const { questions, errors } = parseQuestions(raw);
    const general: string[] = [];
    const byQuestion = new Map<number, string[]>();
    for (const err of errors) {
        const m = /^question (\d+): (.*)$/.exec(err);
        if (m)
            byQuestion.set(Number(m[1]), [
                ...(byQuestion.get(Number(m[1])) ?? []),
                m[2]!,
            ]);
        else general.push(err);
    }
    const count = Array.isArray(raw) ? raw.length : 0;
    if (Array.isArray(raw) && count !== need)
        general.push(
            `Your slots need exactly ${need} questions. This file has ${count}.`,
        );
    if (general.length || byQuestion.size)
        return {
            kind: "invalid",
            file,
            general,
            byQuestion: [...byQuestion.entries()],
        };
    return { kind: "ready", file, questions };
}

function SetterDesk({ signer, role }: { signer: Signer; role: SetterRole }) {
    const { exam, live, refresh } = useExam();
    const now = useNow();
    const cfg = exam.info.config;
    const slots = setterSlots(cfg, exam.info.examId, signer.address);
    const onChain = live.snapshot.setters[role.index]!;
    const sealingOpen =
        live.drandRound < cfg.sealRound && !live.snapshot.sealed;
    const sealAt = roundTimeMs(exam.drand, cfg.sealRound);
    const [draft, setDraft] = useState<Draft>({ kind: "empty" });
    const [run, setRun] = useState<Run>({ kind: "idle" });
    const busy =
        run.kind === "sealing" ||
        run.kind === "signing" ||
        run.kind === "uploading";

    const load = async (file: File) => {
        setRun({ kind: "idle" });
        setDraft(readDraft(file.name, await file.text(), slots.length));
    };

    const submit = async (questions: Question[]) => {
        let stage: "sealing" | "signing" | "uploading" = "sealing";
        let root: Hex | undefined;
        let tx: Tx | undefined;
        try {
            setRun({ kind: "sealing", done: 0, total: questions.length });
            const sealed = await sealBatch(
                cfg,
                exam.drand,
                exam.info.examId,
                signer.address,
                questions,
                (done, total) => setRun({ kind: "sealing", done, total }),
            );
            root = sealed.root;
            stage = "signing";
            setRun({ kind: "signing", root });
            const hash = await send(
                signer.wallet,
                exam.client,
                exam.info.registry,
                "submitSetterRoot",
                [sealed.root, slots.length],
            );
            const [receipt, sent] = await Promise.all([
                exam.client.getTransactionReceipt({ hash }),
                exam.client.getTransactionCount({ address: signer.address }),
            ]);
            tx = {
                hash,
                block: receipt.blockNumber,
                gasUsed: receipt.gasUsed,
                sentByAccount: sent,
            };
            stage = "uploading";
            const total = sealed.bundles.length + 1;
            setRun({ kind: "uploading", root, tx, done: 0, total });
            await exam.store.putManifest(sealed.manifest);
            setRun({ kind: "uploading", root, tx, done: 1, total });
            for (const [k, b] of sealed.bundles.entries()) {
                await exam.store.putBundle(
                    sealed.manifest.leaves[k]!.bundleHash,
                    b,
                );
                setRun({ kind: "uploading", root, tx, done: k + 2, total });
            }
            setRun({ kind: "submitted", root, tx });
            void refresh();
        } catch (e) {
            setRun({
                kind: "failed",
                stage,
                refusal: describeError(e),
                ...(root ? { root } : {}),
                ...(tx ? { tx } : {}),
            });
        }
    };

    return (
        <div className="page">
            <div className="wrap">
                <PageHead
                    title={`Seal your ${cfg.pools[role.pool]} questions`}
                    lead={`As setter ${role.index + 1} you fill ${slots.length} ${cfg.pools[role.pool]} slots: ${role.perShift} for each of ${plural(cfg.shifts.length, "shift")}. The questions are encrypted in this browser and leave it sealed.`}
                >
                    <ul className="facts">
                        <li>
                            <span className="t-label muted">
                                Sealing closes
                            </span>
                            <span>
                                Round {cfg.sealRound}, {clock(sealAt)}{" "}
                                {sealingOpen
                                    ? `(${relative(sealAt, now)})`
                                    : "(closed)"}
                            </span>
                        </li>
                        <li>
                            <span className="t-label muted">
                                Your root on chain
                            </span>
                            <span>
                                {onChain.root ? (
                                    <Hash value={onChain.root} />
                                ) : (
                                    "None yet"
                                )}
                            </span>
                        </li>
                        <li>
                            <span className="t-label muted">
                                Custodian checks
                            </span>
                            <span>
                                <Dots
                                    have={onChain.acks}
                                    need={cfg.threshold}
                                    of={cfg.custodians.length}
                                />{" "}
                                {onChain.acks} acknowledged, {cfg.threshold}{" "}
                                needed
                            </span>
                        </li>
                    </ul>
                </PageHead>

                <div className="grid grid--top desk">
                    <div className="span-7 stack-6">
                        <FilePicker
                            disabled={busy}
                            onFile={(f) => void load(f)}
                        />
                        <DraftView
                            draft={draft}
                            slots={slots.map((s) => s.shift)}
                        />
                    </div>
                    <aside className="span-5 stack-6">
                        <div className="panel-box">
                            <h2 className="box-title">Submission</h2>
                            <SubmitSteps
                                run={run}
                                draft={draft}
                                total={slots.length}
                                acks={onChain.acks}
                                threshold={cfg.threshold}
                                custodians={cfg.custodians.length}
                            />
                            {run.kind === "failed" ? (
                                <RefusalNote
                                    refusal={run.refusal}
                                    title={`Stopped while ${run.stage}`}
                                />
                            ) : null}
                            <div className="btn-row">
                                <button
                                    type="button"
                                    className={`btn ${run.kind === "submitted" ? "btn--secondary" : "btn--primary"}`}
                                    disabled={
                                        draft.kind !== "ready" ||
                                        busy ||
                                        !sealingOpen
                                    }
                                    onClick={() =>
                                        draft.kind === "ready" &&
                                        void submit(draft.questions)
                                    }
                                >
                                    {onChain.root
                                        ? `Seal and replace your root`
                                        : `Seal and submit ${slots.length} questions`}
                                </button>
                            </div>
                            {!sealingOpen ? (
                                <p className="note">
                                    Sealing closed at round {cfg.sealRound}. The
                                    contract refuses new setter roots.
                                </p>
                            ) : null}
                            {sealingOpen &&
                            onChain.root &&
                            run.kind !== "submitted" ? (
                                <p className="note">
                                    A new submission replaces your current root
                                    until round {cfg.sealRound}. Custodians
                                    check it again.
                                </p>
                            ) : null}
                        </div>
                        <CustodianChecks
                            setter={signer.address}
                            root={onChain.root}
                        />
                        <Knowledge />
                    </aside>
                </div>
            </div>
        </div>
    );
}

function FilePicker({
    disabled,
    onFile,
}: {
    disabled: boolean;
    onFile: (f: File) => void;
}) {
    const [over, setOver] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const drop = (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f && !disabled) onFile(f);
    };
    return (
        <div
            className={`dropzone${over ? " is-over" : ""}`}
            onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
        >
            <label htmlFor="questions-file" className="dropzone__label">
                Question file
            </label>
            <p className="dropzone__hint">
                Drop a JSON file here, or choose one. Each question has a text,
                four options and the index of the correct one.
            </p>
            <input
                ref={input}
                id="questions-file"
                type="file"
                accept="application/json,.json"
                disabled={disabled}
                onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onFile(f);
                    e.target.value = "";
                }}
            />
        </div>
    );
}

function DraftView({ draft, slots }: { draft: Draft; slots: number[] }) {
    if (draft.kind === "empty") return null;
    if (draft.kind === "invalid")
        return (
            <div
                className="check-list"
                role="alert"
                aria-label="Problems in the file"
            >
                <p className="check-list__head">
                    <Glyph state="failed" /> {draft.file} cannot be sealed yet
                </p>
                <ul>
                    {draft.general.map((g) => (
                        <li key={g}>{g}</li>
                    ))}
                    {draft.byQuestion.map(([n, errs]) => (
                        <li key={n}>
                            <b>Question {n}</b>: {errs.join("; ")}
                        </li>
                    ))}
                </ul>
            </div>
        );
    return (
        <div className="preview">
            <p className="preview__head">
                <Glyph state="done" /> {draft.file}:{" "}
                {plural(draft.questions.length, "question")} pass the schema
            </p>
            <ol className="preview__list">
                {draft.questions.map((q, i) => (
                    <li key={i} className="question">
                        <p className="question__slot t-label muted">
                            Question {i + 1}, {shiftName(slots[i] ?? 0)} pool
                        </p>
                        <p className="question__text">{q.text}</p>
                        <ol className="question__options" type="A">
                            {q.options.map((o, k) => (
                                <li
                                    key={k}
                                    className={
                                        k === q.correct
                                            ? "is-correct"
                                            : undefined
                                    }
                                >
                                    {o}
                                    {k === q.correct ? (
                                        <span className="question__key">
                                            Answer
                                        </span>
                                    ) : null}
                                </li>
                            ))}
                        </ol>
                    </li>
                ))}
            </ol>
        </div>
    );
}

function SubmitSteps({
    run,
    draft,
    total,
    acks,
    threshold,
    custodians,
}: {
    run: Run;
    draft: Draft;
    total: number;
    acks: number;
    threshold: number;
    custodians: number;
}) {
    const order = ["sealing", "signing", "uploading", "submitted"] as const;
    const at =
        run.kind === "failed"
            ? order.indexOf(run.stage)
            : run.kind === "idle"
              ? -1
              : order.indexOf(run.kind);
    const state = (i: number): StepItem["state"] =>
        run.kind === "failed" && i === at
            ? "failed"
            : i < at || run.kind === "submitted"
              ? "done"
              : i === at
                ? "active"
                : "waiting";
    const tx = "tx" in run ? run.tx : undefined;
    const items: StepItem[] = [
        {
            key: "validate",
            state:
                draft.kind === "ready"
                    ? "done"
                    : draft.kind === "invalid"
                      ? "failed"
                      : "waiting",
            title: "Check the file against the schema",
            detail:
                draft.kind === "ready"
                    ? `${total} questions, one for each slot`
                    : undefined,
        },
        {
            key: "seal",
            state: state(0),
            title: "Seal every question in this browser",
            detail:
                run.kind === "sealing" ? (
                    <>
                        <Bar value={run.done} max={run.total} label="Sealing" />{" "}
                        {run.done} of {run.total}
                    </>
                ) : at > 0 ? (
                    <>
                        Root{" "}
                        <Hash
                            value={"root" in run && run.root ? run.root : "0x"}
                        />
                    </>
                ) : undefined,
        },
        {
            key: "sign",
            state: state(1),
            title: "One wallet transaction: submitSetterRoot",
            detail: tx ? (
                <span className="tx">
                    <Hash value={tx.hash} /> in block {tx.block.toString()},{" "}
                    {tx.gasUsed.toLocaleString("en-GB")} gas.{" "}
                    {tx.sentByAccount === 1
                        ? "The only transaction this account has sent."
                        : `This account has sent ${tx.sentByAccount} transactions.`}
                </span>
            ) : run.kind === "signing" ? (
                "Waiting for the wallet and the block"
            ) : undefined,
        },
        {
            key: "upload",
            state: state(2),
            title: "Upload the manifest and the sealed bundles",
            detail:
                run.kind === "uploading" ? (
                    <>
                        <Bar
                            value={run.done}
                            max={run.total}
                            label="Uploading"
                        />{" "}
                        {run.done} of {run.total}
                    </>
                ) : at > 2 || run.kind === "submitted" ? (
                    "The store checked each one against your on-chain root"
                ) : undefined,
        },
        {
            key: "acks",
            state:
                run.kind === "submitted"
                    ? acks >= threshold
                        ? "done"
                        : "active"
                    : "waiting",
            title: `Custodians check their shares: ${threshold} of ${custodians} needed`,
            detail:
                run.kind === "submitted"
                    ? `${acks} of ${custodians} so far`
                    : undefined,
        },
    ];
    return <Steps items={items} label="Submission progress" />;
}

function CustodianChecks({
    setter,
    root,
}: {
    setter: `0x${string}`;
    root: Hex | null;
}) {
    const { exam, live } = useExam();
    const cfg = exam.info.config;
    const [acked, setAcked] = useState<boolean[]>([]);
    useEffect(() => {
        if (!root) return setAcked([]);
        let gone = false;
        Promise.all(
            cfg.custodians.map(
                (c) =>
                    exam.client.readContract({
                        address: exam.info.registry,
                        abi: examRegistryAbi,
                        functionName: "hasAcknowledged",
                        args: [c.account, setter],
                    } as never) as Promise<boolean>,
            ),
        )
            .then((a) => !gone && setAcked(a))
            .catch(() => undefined);
        return () => {
            gone = true;
        };
    }, [exam, cfg, setter, root, live.fetchedAt]);
    if (!root) return null;
    return (
        <div className="panel-box">
            <h2 className="box-title">Custodian checks on your root</h2>
            <ul className="ack-list">
                {cfg.custodians.map((c, j) => (
                    <li key={c.account}>
                        <Glyph state={acked[j] ? "done" : "waiting"} />
                        <span>Custodian {j + 1}</span>
                        <Hash value={c.account} n={4} />
                        <span className="muted">
                            {acked[j] ? "Holds valid shares" : "Checking"}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function Knowledge() {
    const { exam } = useExam();
    const cfg = exam.info.config;
    return (
        <div className="panel-box knowledge">
            <h2 className="box-title">What you know after submitting</h2>
            <ul className="knowledge__list">
                <li>
                    <Glyph state="done" />
                    Your own questions, and which shift pool each one sits in.
                </li>
                <li>
                    <Glyph state="done" />
                    That {cfg.threshold} custodians hold valid shares for them,
                    from the dots above.
                </li>
                <li>
                    <Glyph state="failed" />
                    Whether any question is picked. The start round's signature
                    decides, and it does not exist until the shift opens.
                </li>
                <li>
                    <Glyph state="failed" />
                    Anyone else's questions, or a way to open your own before
                    the start round. Changing them after round {
                        cfg.sealRound
                    }{" "}
                    is impossible.
                </li>
            </ul>
        </div>
    );
}
