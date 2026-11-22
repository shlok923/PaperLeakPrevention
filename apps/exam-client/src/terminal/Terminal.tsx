import { useEffect, useState } from "react";
import { TerminalSession, type Hex, type Paper } from "@eplp/protocol";
import { unlockRefusal, type Refusal } from "../lib/refusals.ts";
import { loadTerminalId, saveSitting, saveTerminalId } from "../lib/storage.ts";
import {
    NO_PROGRESS,
    watchUnlock,
    type UnlockProgress,
} from "../lib/unlock-progress.ts";
import { CheckIn } from "./CheckIn.tsx";
import { ExamScreen } from "./ExamScreen.tsx";
import { ReceiptScreen } from "./ReceiptScreen.tsx";
import { WaitingRoom } from "./WaitingRoom.tsx";
import { Field } from "../ui.tsx";

export interface Candidate {
    session: TerminalSession;
    rollNo: string;
    transfer: boolean;
}

export interface Receipt {
    sheetHash: Hex;
    receiptCode: string;
    submittedAt: number;
    answered: number;
    auto: boolean;
}

type Phase =
    | { at: "check-in" }
    | { at: "waiting"; c: Candidate; refusal: Refusal | null }
    | { at: "exam"; c: Candidate; paper: Paper; restored: number | null }
    | { at: "receipt"; c: Candidate; receipt: Receipt };

export function Terminal() {
    const [terminalId, setTerminalId] = useState(loadTerminalId);
    if (!terminalId)
        return (
            <TerminalSetup
                onSave={(id) => {
                    saveTerminalId(id);
                    setTerminalId(id);
                }}
            />
        );
    return (
        <TerminalFlow
            terminalId={terminalId}
            onRename={() => {
                saveTerminalId(null);
                setTerminalId(null);
            }}
        />
    );
}

function TerminalFlow({
    terminalId,
    onRename,
}: {
    terminalId: string;
    onRename: () => void;
}) {
    const [phase, setPhase] = useState<Phase>({ at: "check-in" });
    const [progress, setProgress] = useState<UnlockProgress>(NO_PROGRESS);
    useLeaveWarning(phase.at === "waiting" || phase.at === "exam");

    function open(c: Candidate) {
        setProgress(NO_PROGRESS);
        setPhase({ at: "waiting", c, refusal: null });
        const stop = watchUnlock(setProgress);
        (c.session.paper
            ? Promise.resolve(c.session.paper)
            : c.session.unlock()
        )
            .then(async (paper) => {
                if (!c.transfer)
                    return setPhase({ at: "exam", c, paper, restored: null });
                await c.session.restore();
                const restored = paper.items.filter(
                    (it) => c.session.answers.get(it.qid) != null,
                ).length;
                setPhase({ at: "exam", c, paper, restored });
            })
            .catch((e: unknown) =>
                setPhase({ at: "waiting", c, refusal: unlockRefusal(e) }),
            )
            .finally(stop);
    }

    switch (phase.at) {
        case "check-in":
            return (
                <CheckIn
                    terminalId={terminalId}
                    onRename={onRename}
                    onCheckedIn={(session, rollNo) => {
                        saveSitting({
                            rollNo,
                            shift: session.shift,
                            endsAtMs: session.endTimeMs(),
                        });
                        open({
                            session,
                            rollNo,
                            transfer: !!session.checkIn?.entry.replaces,
                        });
                    }}
                />
            );
        case "waiting":
            return (
                <WaitingRoom
                    c={phase.c}
                    progress={progress}
                    refusal={phase.refusal}
                    onRetry={() => open(phase.c)}
                    onLeave={() => {
                        saveSitting(null);
                        setPhase({ at: "check-in" });
                    }}
                />
            );
        case "exam":
            return (
                <ExamScreen
                    c={phase.c}
                    paper={phase.paper}
                    restored={phase.restored}
                    onSubmitted={(receipt) => {
                        saveSitting(null);
                        setPhase({ at: "receipt", c: phase.c, receipt });
                    }}
                    onAbandon={() => {
                        saveSitting(null);
                        setPhase({ at: "check-in" });
                    }}
                />
            );
        case "receipt":
            return (
                <ReceiptScreen
                    c={phase.c}
                    receipt={phase.receipt}
                    onFinish={() => setPhase({ at: "check-in" })}
                />
            );
    }
}

function useLeaveWarning(active: boolean) {
    useEffect(() => {
        if (!active) return;
        const warn = (e: BeforeUnloadEvent) => e.preventDefault();
        addEventListener("beforeunload", warn);
        return () => removeEventListener("beforeunload", warn);
    }, [active]);
}

function TerminalSetup({ onSave }: { onSave: (id: string) => void }) {
    const [id, setId] = useState("");
    const [error, setError] = useState<string>();
    return (
        <main>
            <section className="setup" aria-labelledby="setup-h">
                <div className="wrap">
                    <div className="hero-text setup__grid enter">
                        <form
                            className="setup__form"
                            noValidate
                            onSubmit={(e) => {
                                e.preventDefault();
                                const clean = id.trim().toUpperCase();
                                if (!/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(clean)) {
                                    setError(
                                        "Type the label on the desk, such as T-01: letters, digits and dashes.",
                                    );
                                    return;
                                }
                                onSave(clean);
                            }}
                        >
                            <p className="label">Terminal setup</p>
                            <h1 className="display display--md" id="setup-h">
                                Name this terminal.
                            </h1>
                            <p className="lead">
                                Use the label on the desk. The hall server
                                records it with every check-in, and the proctor
                                console lists candidates by it.
                            </p>
                            <Field
                                id="terminal"
                                label="Terminal ID"
                                value={id}
                                error={error}
                                hint="Up to 16 letters, digits and dashes."
                                placeholder="T-01"
                                autoComplete="off"
                                autoCapitalize="characters"
                                spellCheck={false}
                                className="input--mono"
                                onChange={(e) => setId(e.target.value)}
                            />
                            <div className="btn-row">
                                <button
                                    type="submit"
                                    className="btn btn--primary"
                                >
                                    Save terminal
                                </button>
                            </div>
                        </form>
                        <HallMap />
                    </div>
                </div>
            </section>
        </main>
    );
}

function HallMap() {
    return (
        <div
            className="hallmap panel"
            role="img"
            aria-label={`This terminal reaches only the hall server at ${location.host}, which relays the drand start signal, the key holders' sealed replies and the encrypted papers.`}
        >
            <div className="hallmap__node">
                <span className="label">This terminal</span>
                <span>Kiosk browser</span>
            </div>
            <div className="hallmap__node hallmap__node--hub">
                <span className="label">Hall server</span>
                <span className="mono">{location.host}</span>
            </div>
            <div className="hallmap__branches">
                <div className="hallmap__node">
                    <span className="label">Start signal</span>
                    <span>drand beacon</span>
                </div>
                <div className="hallmap__node">
                    <span className="label">Keys</span>
                    <span>Key holders</span>
                </div>
                <div className="hallmap__node">
                    <span className="label">Papers</span>
                    <span>Sealed bundles</span>
                </div>
            </div>
        </div>
    );
}
