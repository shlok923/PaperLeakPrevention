import { useEffect, useState, type FormEvent } from "react";
import { TerminalSession, type GatewayExam } from "@eplp/protocol";
import {
    API_BASE,
    currentRound,
    fetchExam,
    pickShift,
    roundTime,
    shiftLabel,
    type ShiftPick,
} from "../lib/exam.ts";
import { checkInRefusal, type Refusal } from "../lib/refusals.ts";
import { loadSitting } from "../lib/storage.ts";
import { clockTime, countdown, useNow } from "../lib/time.ts";
import { Field, Notice } from "../ui.tsx";

const unreachable: Refusal = {
    title: "This terminal cannot reach the hall server.",
    detail: "It keeps trying every few seconds. If this stays, tell a proctor.",
};

function usePolledExam(everyMs: number): {
    exam: GatewayExam | null;
    offline: boolean;
} {
    const [state, setState] = useState<{
        exam: GatewayExam | null;
        offline: boolean;
    }>({ exam: null, offline: false });
    useEffect(() => {
        let live = true;
        const load = () =>
            fetchExam().then(
                (exam) => live && setState({ exam, offline: false }),
                () => live && setState((s) => ({ ...s, offline: true })),
            );
        void load();
        const id = setInterval(load, everyMs);
        return () => {
            live = false;
            clearInterval(id);
        };
    }, [everyMs]);
    return state;
}

export function CheckIn({
    terminalId,
    onRename,
    onCheckedIn,
}: {
    terminalId: string;
    onRename: () => void;
    onCheckedIn: (session: TerminalSession, rollNo: string) => void;
}) {
    const { exam, offline } = usePolledExam(4000);
    const now = useNow(500);
    const [sitting] = useState(loadSitting);
    const [rollNo, setRollNo] = useState(sitting?.rollNo ?? "");
    const [code, setCode] = useState("");
    const [errors, setErrors] = useState<{ rollNo?: string; code?: string }>(
        {},
    );
    const [refusal, setRefusal] = useState<Refusal | null>(null);
    const [busy, setBusy] = useState(false);

    const pick: ShiftPick | null = exam && pickShift(exam);
    const shift = pick && pick.status !== "over" ? pick : null;
    const ready =
        !!exam &&
        !!shift &&
        exam.ready &&
        (exam.allocated[shift.shift] ?? 0) > 0;

    async function submit(e: FormEvent) {
        e.preventDefault();
        const next = {
            ...(rollNo.trim()
                ? {}
                : {
                      rollNo: "Type the roll number printed on your admit card.",
                  }),
            ...(code.trim()
                ? {}
                : {
                      code: "Type the six-character check-in code from your admit card.",
                  }),
        };
        setErrors(next);
        setRefusal(null);
        if (Object.keys(next).length) {
            document.getElementById(next.rollNo ? "roll" : "code")?.focus();
            return;
        }
        if (!shift) return;
        setBusy(true);
        try {
            onCheckedIn(
                await TerminalSession.start(
                    API_BASE,
                    shift.shift,
                    terminalId,
                    rollNo.trim(),
                    code.trim(),
                ),
                rollNo.trim().toUpperCase(),
            );
        } catch (err) {
            setRefusal(checkInRefusal(err));
            setBusy(false);
        }
    }

    return (
        <main className="checkin enter">
            <section className="checkin__intro" aria-labelledby="exam-title">
                <p className="label">
                    {exam ? exam.center.name : "Hall server"} · Terminal{" "}
                    {terminalId}
                </p>
                <h1 className="display" id="exam-title">
                    {exam ? exam.config.title : "Connecting to the hall server"}
                </h1>
                {exam && <ShiftLine exam={exam} pick={pick!} now={now} />}
                <ol className="steps">
                    <li>
                        <span className="steps__n">1</span>Show your photo ID to
                        the proctor at your row.
                    </li>
                    <li>
                        <span className="steps__n">2</span>Type the roll number
                        and check-in code from your admit card.
                    </li>
                    <li>
                        <span className="steps__n">3</span>Stay at this
                        terminal. Your paper opens on this screen at the start
                        time.
                    </li>
                </ol>
            </section>

            <form
                className="panel checkin__form"
                noValidate
                onSubmit={submit}
                aria-labelledby="checkin-h"
            >
                <h2 id="checkin-h">Check in</h2>
                {sitting && !refusal && (
                    <Notice
                        tone="info"
                        refusal={{
                            title: `This terminal restarted while ${sitting.rollNo} was checked in.`,
                            detail: "Your answers up to the last save are on the hall server. Ask a proctor to approve a transfer, then check in again.",
                        }}
                    />
                )}
                {offline && <Notice refusal={unreachable} />}
                {exam && !shift && (
                    <Notice
                        tone="info"
                        refusal={{
                            title: "No more shifts at this hall today.",
                            detail: "Check-in is closed on this terminal.",
                        }}
                    />
                )}
                {exam && shift && !ready && (
                    <Notice
                        tone="info"
                        refusal={{
                            title: "The hall server is still loading the sealed papers.",
                            detail: "Check-in opens here as soon as it has them. You do not need to reload.",
                        }}
                    />
                )}
                <Field
                    id="roll"
                    label="Roll number"
                    value={rollNo}
                    error={errors.rollNo}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="input--mono"
                    onChange={(e) => setRollNo(e.target.value)}
                />
                <Field
                    id="code"
                    label="Check-in code"
                    value={code}
                    error={errors.code}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="input--mono"
                    onChange={(e) => setCode(e.target.value)}
                />
                <div className="btn-row">
                    <button
                        type="submit"
                        className="btn btn--primary btn--wide"
                        disabled={!ready || busy}
                    >
                        {busy ? "Checking in…" : "Check in"}
                    </button>
                </div>
                <div aria-live="polite">
                    {refusal && <Notice refusal={refusal} />}
                </div>
                <p className="small muted checkin__foot">
                    Wrong terminal label?{" "}
                    <button type="button" className="link" onClick={onRename}>
                        Rename this terminal
                    </button>
                </p>
            </form>
        </main>
    );
}

function ShiftLine({
    exam,
    pick,
    now,
}: {
    exam: GatewayExam;
    pick: ShiftPick;
    now: number;
}) {
    if (pick.status === "over")
        return <p className="lead">Every shift at this hall has ended.</p>;
    const startsAt = roundTime(exam, pick.start);
    const label = shiftLabel(pick.shift);
    if (pick.status === "upcoming")
        return (
            <p className="lead">
                {label} starts at{" "}
                <span className="num">{clockTime(startsAt)}</span>, in{" "}
                <span className="num">{countdown(startsAt - now)}</span>.
            </p>
        );
    const lateEntryEnds = roundTime(exam, pick.lateEntryEnd + 1);
    return (
        <p className="lead">
            {label} started at{" "}
            <span className="num">{clockTime(startsAt)}</span>. Late entry{" "}
            {currentRound(exam) > pick.lateEntryEnd ? "closed" : "closes"} at{" "}
            <span className="num">{clockTime(lateEntryEnds)}</span>.
        </p>
    );
}
