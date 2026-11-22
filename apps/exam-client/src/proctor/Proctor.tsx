import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
    getJson,
    HttpError,
    postJson,
    type GatewayExam,
    type Hex,
} from "@eplp/protocol";
import {
    API_BASE,
    fetchExam,
    pickShift,
    roundTime,
    shiftLabel,
} from "../lib/exam.ts";
import { clockTime } from "../lib/time.ts";
import { Field, Mark, Notice, TopBar } from "../ui.tsx";

interface SessionRow {
    candidateHash: Hex;
    terminal: string;
    session: Hex;
    replaced: boolean;
    submitted: boolean;
    transferApproved: boolean;
}

type RowStatus = "submitted" | "replaced" | "approved" | "live";

const statusOf = (r: SessionRow): RowStatus =>
    r.replaced
        ? "replaced"
        : r.submitted
          ? "submitted"
          : r.transferApproved
            ? "approved"
            : "live";

const STATUS_TEXT: Record<RowStatus, string> = {
    live: "Sitting",
    approved: "Transfer approved",
    submitted: "Submitted",
    replaced: "Moved to another terminal",
};

const sessionsUrl = (pin: string, shift: number) =>
    `${API_BASE}/api/proctor/sessions?pin=${encodeURIComponent(pin)}&shift=${shift}`;

const shortHash = (h: Hex) => `${h.slice(0, 8)}…${h.slice(-4)}`;

export function Proctor() {
    const [pin, setPin] = useState<string | null>(null);
    const [exam, setExam] = useState<GatewayExam | null>(null);
    useEffect(() => {
        let live = true;
        const load = () =>
            fetchExam().then(
                (e) => live && setExam(e),
                () => live && setTimeout(load, 3000),
            );
        void load();
        return () => {
            live = false;
        };
    }, []);
    return pin && exam ? (
        <Console pin={pin} exam={exam} />
    ) : (
        <PinEntry exam={exam} onOpen={setPin} />
    );
}

function PinEntry({
    exam,
    onOpen,
}: {
    exam: GatewayExam | null;
    onOpen: (pin: string) => void;
}) {
    const [pin, setPin] = useState("");
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!pin.trim()) {
            setError("Type the proctor PIN for this hall.");
            return;
        }
        setBusy(true);
        try {
            await getJson(sessionsUrl(pin.trim(), 0));
            onOpen(pin.trim());
        } catch (err) {
            setError(
                err instanceof HttpError && err.status === 403
                    ? "That PIN is not right for this hall."
                    : "The hall server did not answer. Try again.",
            );
            setBusy(false);
        }
    }
    return (
        <main>
            <section className="solo enter" aria-label="Proctor sign-in">
                <form className="solo__card" noValidate onSubmit={submit}>
                    <Mark />
                    <p className="label">
                        {exam
                            ? `${exam.center.name} · ${exam.config.title}`
                            : "Hall server"}
                    </p>
                    <h1 className="display display--md">Proctor console</h1>
                    <p className="lead">
                        Watch who is checked in at each terminal, and approve a
                        move when a terminal fails.
                    </p>
                    <Field
                        id="pin"
                        label="Proctor PIN"
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        value={pin}
                        error={error}
                        onChange={(e) => setPin(e.target.value)}
                    />
                    <div className="btn-row">
                        <button
                            type="submit"
                            className="btn btn--primary"
                            disabled={busy || !exam}
                        >
                            {busy ? "Opening…" : "Open console"}
                        </button>
                    </div>
                </form>
            </section>
        </main>
    );
}

function Console({ pin, exam }: { pin: string; exam: GatewayExam }) {
    const auto = pickShift(exam);
    const [shift, setShift] = useState(auto.status === "over" ? 0 : auto.shift);
    const [rows, setRows] = useState<SessionRow[] | null>(null);
    const [updated, setUpdated] = useState<number | null>(null);
    const [offline, setOffline] = useState(false);
    const [confirm, setConfirm] = useState<Hex | null>(null);
    const [approveError, setApproveError] = useState<string | null>(null);

    const load = useCallback(
        async (isCurrent: () => boolean = () => true) => {
            try {
                const next = await getJson<SessionRow[]>(
                    sessionsUrl(pin, shift),
                );
                if (!isCurrent()) return;
                setRows(next);
                setUpdated(Date.now());
                setOffline(false);
            } catch {
                if (isCurrent()) setOffline(true);
            }
        },
        [pin, shift],
    );

    useEffect(() => {
        let current = true;
        setRows(null);
        void load(() => current);
        const id = setInterval(() => void load(() => current), 3000);
        return () => {
            current = false;
            clearInterval(id);
        };
    }, [load]);

    async function approve(candidateHash: Hex) {
        try {
            await postJson(`${API_BASE}/api/proctor/transfer`, {
                pin,
                shift,
                candidateHash,
            });
            setApproveError(null);
            setConfirm(null);
            await load();
        } catch {
            setApproveError(
                "The hall server did not record that approval. Try again.",
            );
        }
    }

    const shiftWindow = exam.windows[shift]!;
    const counts = { live: 0, submitted: 0, moved: 0 };
    for (const r of rows ?? []) {
        const st = statusOf(r);
        if (st === "submitted") counts.submitted++;
        else if (st === "replaced") counts.moved++;
        else counts.live++;
    }

    return (
        <div className="screen">
            <TopBar
                title="Proctor console"
                sub={`${exam.center.name} · ${exam.config.title}`}
            >
                <p className="save" data-state={offline ? "failed" : "saved"}>
                    <span className="save__dot" aria-hidden="true" />
                    {offline
                        ? "Hall server not answering"
                        : updated
                          ? `Updated ${clockTime(updated)}`
                          : "Loading…"}
                </p>
            </TopBar>
            <main className="console enter">
                <div className="console__head">
                    <div className="tabs" role="tablist" aria-label="Shift">
                        {exam.windows.map((w, i) => (
                            <button
                                key={i}
                                type="button"
                                role="tab"
                                className="tabs__tab"
                                aria-selected={i === shift}
                                onClick={() => setShift(i)}
                            >
                                {shiftLabel(i)}
                                <span className="num muted">
                                    {clockTime(roundTime(exam, w.start))}
                                </span>
                            </button>
                        ))}
                    </div>
                    <dl className="tally tally--inline">
                        <div>
                            <dt>Sitting</dt>
                            <dd className="num">{counts.live}</dd>
                        </div>
                        <div>
                            <dt>Submitted</dt>
                            <dd className="num">{counts.submitted}</dd>
                        </div>
                        <div>
                            <dt>Moved</dt>
                            <dd className="num">{counts.moved}</dd>
                        </div>
                    </dl>
                </div>

                <section
                    className="panel console__table"
                    aria-labelledby="sessions-h"
                >
                    <h2 id="sessions-h" className="sr-only">
                        Check-ins for {shiftLabel(shift)}
                    </h2>
                    {rows === null ? (
                        <p className="muted">Loading check-ins…</p>
                    ) : rows.length === 0 ? (
                        <p className="muted">
                            No one has checked in for {shiftLabel(shift)} yet.
                        </p>
                    ) : (
                        <table>
                            <thead>
                                <tr>
                                    <th scope="col">Terminal</th>
                                    <th scope="col">Candidate</th>
                                    <th scope="col">Status</th>
                                    <th scope="col">
                                        <span className="sr-only">Action</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => {
                                    const st = statusOf(r);
                                    return (
                                        <tr key={r.session} data-status={st}>
                                            <td className="mono">
                                                {r.terminal}
                                            </td>
                                            <td
                                                className="mono"
                                                title={r.candidateHash}
                                            >
                                                {shortHash(r.candidateHash)}
                                            </td>
                                            <td>
                                                <span
                                                    className="status"
                                                    data-status={st}
                                                >
                                                    {STATUS_TEXT[st]}
                                                </span>
                                            </td>
                                            <td className="console__action">
                                                {st === "live" &&
                                                    (confirm ===
                                                    r.candidateHash ? (
                                                        <span className="btn-row btn-row--end">
                                                            <button
                                                                type="button"
                                                                className="btn btn--secondary btn--sm"
                                                                onClick={() =>
                                                                    setConfirm(
                                                                        null,
                                                                    )
                                                                }
                                                            >
                                                                Cancel
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="btn btn--primary btn--sm"
                                                                onClick={() =>
                                                                    void approve(
                                                                        r.candidateHash,
                                                                    )
                                                                }
                                                            >
                                                                Approve move
                                                                from{" "}
                                                                {r.terminal}
                                                            </button>
                                                        </span>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            className="btn btn--secondary btn--sm"
                                                            onClick={() =>
                                                                setConfirm(
                                                                    r.candidateHash,
                                                                )
                                                            }
                                                        >
                                                            Approve transfer
                                                        </button>
                                                    ))}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </section>
                {approveError && (
                    <Notice
                        refusal={{
                            title: approveError,
                            detail: "The candidate cannot move until the approval is recorded.",
                        }}
                    />
                )}
                {offline && (
                    <Notice
                        refusal={{
                            title: "The hall server is not answering.",
                            detail: "The list shows the last update. It retries every 3 seconds.",
                        }}
                    />
                )}
                <p className="small muted console__help">
                    Approve a transfer only after checking the candidate’s photo
                    ID. They then check in at a spare terminal with the same
                    roll number and code, and their saved answers move with
                    them. The old terminal can no longer submit. The key holders
                    open the paper again for the new terminal only until late
                    entry closes, at{" "}
                    <span className="num">
                        {clockTime(
                            roundTime(
                                exam,
                                Math.min(
                                    shiftWindow.start +
                                        exam.config.lateEntryRounds,
                                    shiftWindow.end,
                                ) + 1,
                            ),
                        )}
                    </span>{" "}
                    for {shiftLabel(shift)}.
                </p>
            </main>
        </div>
    );
}
