import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    HttpError,
    watermark,
    type Paper,
    type TerminalSession,
} from "@eplp/protocol";
import { shiftLabel } from "../lib/exam.ts";
import { submitRefusal, type Refusal } from "../lib/refusals.ts";
import { clockTime, countdown, useNow } from "../lib/time.ts";
import { watermarkTile } from "../lib/watermark.ts";
import { Arrow, Flag, Notice, TopBar } from "../ui.tsx";
import type { Candidate, Receipt } from "./Terminal.tsx";
import { Identity } from "./WaitingRoom.tsx";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const AUTOSAVE_MS = 3000;
const BEACON_STALE_MS = 10_000;

type Status =
    "answered-marked" | "marked" | "answered" | "unanswered" | "unvisited";

type SubmitState =
    | { at: "idle" }
    | { at: "sending"; auto: boolean }
    | { at: "failed"; auto: boolean; refusal: Refusal; final: boolean };

export function ExamScreen({
    c,
    paper,
    restored,
    onSubmitted,
    onAbandon,
}: {
    c: Candidate;
    paper: Paper;
    restored: number | null;
    onSubmitted: (r: Receipt) => void;
    onAbandon: () => void;
}) {
    const s = c.session;
    const cfg = s.exam.config;
    const items = paper.items;
    const [index, setIndex] = useState(0);
    const [choices, setChoices] = useState(() =>
        items.map((it) => s.displayChoice(it.qid)),
    );
    const [visited, setVisited] = useState(
        () =>
            new Set([
                0,
                ...choices.flatMap((ch, i) => (ch === null ? [] : [i])),
            ]),
    );
    const [marked, setMarked] = useState<ReadonlySet<number>>(new Set());
    const [showRestored, setShowRestored] = useState(restored !== null);
    const [confirming, setConfirming] = useState(false);
    const [submit, setSubmit] = useState<SubmitState>({ at: "idle" });
    const save = useAutosave(s);
    const beacon = useBeaconClock(s);
    const now = useNow(500);
    const endsAt = s.endTimeMs();
    const timeUp =
        beacon.current.round >= s.window.end ||
        (now - beacon.current.seenAt > BEACON_STALE_MS && now >= endsAt);
    const replaced = submit.at === "failed" && submit.final;
    const locked = timeUp || submit.at === "sending" || replaced;
    const item = items[index]!;
    const tile = useMemo(
        () => watermarkTile(watermark(s, c.rollNo)),
        [s, c.rollNo],
    );

    const answered = choices.filter((ch) => ch !== null).length;
    const statusOf = (i: number): Status => {
        const isAnswered = choices[i] !== null;
        if (marked.has(i)) return isAnswered ? "answered-marked" : "marked";
        if (isAnswered) return "answered";
        return visited.has(i) ? "unanswered" : "unvisited";
    };
    const counts = {
        answered,
        marked: marked.size,
        unanswered: 0,
        unvisited: 0,
    };
    for (let i = 0; i < items.length; i++) {
        const st = statusOf(i);
        if (st === "unanswered") counts.unanswered++;
        if (st === "unvisited") counts.unvisited++;
    }

    const go = (i: number) => {
        setIndex(i);
        setVisited((v) => (v.has(i) ? v : new Set(v).add(i)));
    };

    const choose = (display: number | null) => {
        if (locked) return;
        s.answer(item.qid, display, beacon.current.round);
        setChoices(items.map((it) => s.displayChoice(it.qid)));
        save.request();
    };

    const sending = useRef(false);
    const lastAttempt = useRef(0);
    const send = useCallback(
        async (auto: boolean) => {
            if (sending.current) return;
            sending.current = true;
            lastAttempt.current = Date.now();
            setConfirming(false);
            setSubmit({ at: "sending", auto });
            try {
                const r = await s.submit(beacon.current.round);
                onSubmitted({
                    ...r,
                    submittedAt: Date.now(),
                    answered: [...s.answers.values()].filter((v) => v !== null)
                        .length,
                    auto,
                });
            } catch (e) {
                sending.current = false;
                setSubmit({
                    at: "failed",
                    auto,
                    refusal: submitRefusal(e),
                    final: e instanceof HttpError && e.status === 403,
                });
            }
        },
        [s, beacon, onSubmitted],
    );

    useEffect(() => {
        if (
            timeUp &&
            !replaced &&
            !sending.current &&
            Date.now() - lastAttempt.current > 3000
        )
            void send(true);
    }, [timeUp, replaced, now, send]);

    const left = endsAt - now;
    return (
        <div className="screen screen--exam">
            <TopBar
                title={cfg.title}
                sub={`${s.exam.center.name} · ${shiftLabel(s.shift)}`}
            >
                <SaveIndicator status={save.status} />
                <div
                    className={`timer${left < 60_000 ? " timer--low" : ""}`}
                    role="timer"
                    aria-label={`Time left ${countdown(left)}`}
                >
                    <p className="timer__label">Time left</p>
                    <p className="timer__value num">{countdown(left)}</p>
                </div>
                <Identity rollNo={c.rollNo} terminalId={s.terminalId} />
            </TopBar>

            <div className="exam">
                <main
                    className="question"
                    aria-labelledby="q-h"
                    onCopy={(e) => e.preventDefault()}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <div className="question__inner">
                        {showRestored && restored !== null && (
                            <div
                                className="notice notice--info notice--row"
                                role="status"
                            >
                                <p>
                                    <span className="notice__title">
                                        You moved to this terminal.
                                    </span>{" "}
                                    {restored === 0
                                        ? "No saved answers needed restoring."
                                        : `${restored} saved answer${restored === 1 ? " was" : "s were"} restored.`}
                                </p>
                                <button
                                    type="button"
                                    className="link"
                                    onClick={() => setShowRestored(false)}
                                >
                                    Dismiss
                                </button>
                            </div>
                        )}
                        <p className="label">
                            Question {index + 1} of {items.length} ·{" "}
                            {cfg.pools[item.pool] ?? `Section ${item.pool + 1}`}
                        </p>
                        <h1 className="question__text" id="q-h">
                            {item.text}
                        </h1>
                        {item.image && (
                            <img
                                className="question__image"
                                src={`data:${item.image.mime};base64,${item.image.data}`}
                                alt="Figure for this question"
                            />
                        )}
                        <fieldset className="options" disabled={locked}>
                            <legend className="sr-only">
                                Choose one answer
                            </legend>
                            {item.options.map((opt, i) => (
                                <label
                                    key={`${item.qid}-${i}`}
                                    className="option"
                                >
                                    <input
                                        type="radio"
                                        name={`q-${item.qid}`}
                                        checked={choices[index] === i}
                                        onChange={() => choose(i)}
                                    />
                                    <span
                                        className="option__key"
                                        aria-hidden="true"
                                    >
                                        {LETTERS[i]}
                                    </span>
                                    <span className="option__text">{opt}</span>
                                </label>
                            ))}
                        </fieldset>
                    </div>
                    <div className="watermark" aria-hidden="true">
                        <div
                            className="watermark__layer"
                            style={{ backgroundImage: tile }}
                        />
                    </div>
                    <nav
                        className="question__actions"
                        aria-label="Question actions"
                    >
                        <div className="btn-row">
                            <button
                                type="button"
                                className="btn btn--secondary"
                                disabled={locked || choices[index] === null}
                                onClick={() => choose(null)}
                            >
                                Clear response
                            </button>
                            <button
                                type="button"
                                className="btn btn--secondary"
                                aria-pressed={marked.has(index)}
                                disabled={locked}
                                onClick={() =>
                                    setMarked((m) => {
                                        const next = new Set(m);
                                        if (!next.delete(index))
                                            next.add(index);
                                        return next;
                                    })
                                }
                            >
                                <Flag />
                                {marked.has(index)
                                    ? "Unmark review"
                                    : "Mark for review"}
                            </button>
                        </div>
                        <div className="btn-row">
                            <button
                                type="button"
                                className="btn btn--secondary"
                                disabled={index === 0}
                                onClick={() => go(index - 1)}
                            >
                                <Arrow back />
                                Previous
                            </button>
                            <button
                                type="button"
                                className="btn btn--primary"
                                disabled={index === items.length - 1}
                                onClick={() => go(index + 1)}
                            >
                                Next question
                                <Arrow />
                            </button>
                        </div>
                    </nav>
                </main>

                <aside className="palette" aria-labelledby="palette-h">
                    <h2 id="palette-h">Questions</h2>
                    <ul className="legend">
                        <li data-status="answered">
                            <span
                                className="legend__swatch"
                                aria-hidden="true"
                            />
                            Answered{" "}
                            <span className="num">{counts.answered}</span>
                        </li>
                        <li data-status="unanswered">
                            <span
                                className="legend__swatch"
                                aria-hidden="true"
                            />
                            Not answered{" "}
                            <span className="num">{counts.unanswered}</span>
                        </li>
                        <li data-status="marked">
                            <span
                                className="legend__swatch"
                                aria-hidden="true"
                            />
                            Marked for review{" "}
                            <span className="num">{counts.marked}</span>
                        </li>
                        <li data-status="unvisited">
                            <span
                                className="legend__swatch"
                                aria-hidden="true"
                            />
                            Not visited{" "}
                            <span className="num">{counts.unvisited}</span>
                        </li>
                    </ul>
                    <ol className="grid">
                        {items.map((it, i) => (
                            <li key={it.qid}>
                                <button
                                    type="button"
                                    className="tile"
                                    data-status={statusOf(i)}
                                    aria-current={
                                        i === index ? "step" : undefined
                                    }
                                    aria-label={`Question ${i + 1}, ${STATUS_WORDS[statusOf(i)]}`}
                                    onClick={() => go(i)}
                                >
                                    {i + 1}
                                </button>
                            </li>
                        ))}
                    </ol>
                    <p className="small muted palette__note">
                        Marked questions that have an answer are still
                        submitted.
                    </p>
                    <button
                        type="button"
                        className="btn btn--secondary btn--wide"
                        disabled={locked}
                        onClick={() => setConfirming(true)}
                    >
                        Submit answers
                    </button>
                </aside>
            </div>

            <SubmitDialog
                open={confirming || submit.at !== "idle"}
                counts={counts}
                total={items.length}
                endsAt={endsAt}
                submit={submit}
                onCancel={() => {
                    setConfirming(false);
                    if (!timeUp) setSubmit({ at: "idle" });
                }}
                onConfirm={() => (replaced ? onAbandon() : void send(timeUp))}
            />
        </div>
    );
}

const STATUS_WORDS: Record<Status, string> = {
    "answered-marked": "answered and marked for review",
    marked: "marked for review",
    answered: "answered",
    unanswered: "not answered",
    unvisited: "not visited",
};

function SubmitDialog({
    open,
    counts,
    total,
    endsAt,
    submit,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    counts: {
        answered: number;
        marked: number;
        unanswered: number;
        unvisited: number;
    };
    total: number;
    endsAt: number;
    submit: SubmitState;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (open && !d.open) d.showModal();
        if (!open && d.open) d.close();
    }, [open]);
    const auto = submit.at !== "idle" && submit.auto;
    const replaced = submit.at === "failed" && submit.final;
    return (
        <dialog
            ref={ref}
            className="dialog"
            aria-labelledby="submit-h"
            onCancel={(e) => {
                e.preventDefault();
                if (!auto && !replaced && submit.at !== "sending") onCancel();
            }}
            onClose={() => {
                if (!open) return;
                if (!auto && !replaced && submit.at !== "sending") onCancel();
                else ref.current?.showModal();
            }}
        >
            {replaced ? (
                <>
                    <h2 id="submit-h">{submit.refusal.title}</h2>
                    <p className="lead">{submit.refusal.detail}</p>
                </>
            ) : (
                <>
                    <h2 id="submit-h">
                        {auto ? "Time is up." : "Submit your answers?"}
                    </h2>
                    <p className="lead">
                        {auto
                            ? "Your answers are being signed and submitted."
                            : `You still have until ${clockTime(endsAt)}. After you submit, you cannot change any answer.`}
                    </p>
                    <dl className="tally">
                        <div>
                            <dt>Answered</dt>
                            <dd>
                                <span className="num">{counts.answered}</span>{" "}
                                of <span className="num">{total}</span>
                            </dd>
                        </div>
                        <div>
                            <dt>Not answered</dt>
                            <dd className="num">
                                {counts.unanswered + counts.unvisited}
                            </dd>
                        </div>
                        <div>
                            <dt>Marked for review</dt>
                            <dd className="num">{counts.marked}</dd>
                        </div>
                    </dl>
                    {submit.at === "failed" && (
                        <Notice refusal={submit.refusal} />
                    )}
                </>
            )}
            <div className="btn-row btn-row--end">
                {!auto && !replaced && (
                    <button
                        type="button"
                        className="btn btn--secondary"
                        disabled={submit.at === "sending"}
                        onClick={onCancel}
                    >
                        Keep answering
                    </button>
                )}
                <button
                    type="button"
                    className="btn btn--primary"
                    disabled={submit.at === "sending"}
                    onClick={onConfirm}
                >
                    {replaced
                        ? "Clear this terminal"
                        : submit.at === "sending"
                          ? "Submitting…"
                          : submit.at === "failed"
                            ? "Try again"
                            : "Submit answers"}
                </button>
            </div>
        </dialog>
    );
}

type SaveStatus = {
    state: "idle" | "saving" | "saved" | "failed";
    at: number | null;
};

function useAutosave(s: TerminalSession) {
    const [status, setStatus] = useState<SaveStatus>({
        state: "idle",
        at: null,
    });
    const dirty = useRef(false);
    const inFlight = useRef(false);

    const flush = useCallback(async (): Promise<void> => {
        if (inFlight.current || !dirty.current) return;
        inFlight.current = true;
        dirty.current = false;
        setStatus((st) => ({ ...st, state: "saving" }));
        try {
            await s.flush();
            setStatus({ state: "saved", at: Date.now() });
        } catch {
            dirty.current = true;
            setStatus((st) => ({ ...st, state: "failed" }));
            return;
        } finally {
            inFlight.current = false;
        }
        if (dirty.current) await flush();
    }, [s]);

    useEffect(() => {
        const id = setInterval(() => void flush(), AUTOSAVE_MS);
        return () => clearInterval(id);
    }, [flush]);

    const request = useCallback(() => {
        dirty.current = true;
        void flush();
    }, [flush]);

    return { status, request };
}

function SaveIndicator({ status }: { status: SaveStatus }) {
    const text =
        status.state === "saving"
            ? "Saving…"
            : status.state === "failed"
              ? "Not saved yet. Retrying"
              : status.at
                ? `Saved ${clockTime(status.at)}`
                : "Answers save as you go";
    return (
        <p className="save" data-state={status.state}>
            <span className="save__dot" aria-hidden="true" />
            {text}
            {status.state === "failed" && (
                <span className="sr-only" role="alert">
                    Your latest answers are not saved yet. The terminal keeps
                    retrying.
                </span>
            )}
        </p>
    );
}

function useBeaconClock(s: TerminalSession) {
    const clock = useRef({ round: s.window.start, seenAt: 0 });
    useEffect(() => {
        let live = true;
        const poll = () =>
            s.latestRound().then(
                (r) => {
                    if (live)
                        clock.current = {
                            round: Math.max(r, clock.current.round),
                            seenAt: Date.now(),
                        };
                },
                () => undefined,
            );
        void poll();
        const id = setInterval(poll, 1000);
        return () => {
            live = false;
            clearInterval(id);
        };
    }, [s]);
    return clock;
}
