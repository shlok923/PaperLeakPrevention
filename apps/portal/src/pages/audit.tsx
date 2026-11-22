import { useState } from "react";
import { auditExam, roundTimeMs, type Check } from "@eplp/protocol";
import { describeError, type Refusal } from "../errors.ts";
import { useExam } from "../exam.tsx";
import { clock, plural } from "../format.ts";
import { collectReleased } from "../records.ts";
import { Glyph, PageHead, RefusalNote } from "../ui.tsx";

const MEANING: Record<string, string> = {
    "Config hash": "The rules everyone sees are the rules the contract froze.",
    "drand key encodings agree":
        "The key used to time-lock questions is the key the contract checks beacons with.",
    "Setter batches":
        "Only batches the custodians confirmed before sealing could appear in a paper.",
    "Start beacons on chain":
        "Every shift opened on a drand signature the contract verified itself.",
    "Paper selection":
        "Each sheet holds exactly the questions the start beacon picked, so no one chose the paper.",
    "Check-ins":
        "Every candidate who sat was allocated to that center, and the center signed the check-in.",
    "Answer sheets":
        "Each sheet is signed by the session that sat the exam, and matches the root the center posted.",
    "Key releases":
        "No custodian released a key before its shift's start round.",
    "Released questions open to their commitments":
        "The questions people saw are the ones setters committed to before sealing.",
    Results:
        "Scores follow from the sheets and the answer key, and match the root on chain.",
};

type Run =
    | { kind: "idle" }
    | { kind: "collecting"; waiting?: boolean }
    | { kind: "checking" }
    | { kind: "done"; checks: Check[]; at: number }
    | { kind: "failed"; refusal: Refusal };

export function AuditPage() {
    const { exam, live } = useExam();
    const cfg = exam.info.config;
    const [run, setRun] = useState<Run>({ kind: "idle" });
    const ready = live.snapshot.latestRound >= cfg.answersRound;
    const busy = run.kind === "collecting" || run.kind === "checking";

    const audit = async () => {
        try {
            setRun({ kind: "collecting" });
            const records = await collectReleased(exam, () =>
                setRun({ kind: "collecting", waiting: true }),
            );
            setRun({ kind: "checking" });
            setRun({
                kind: "done",
                checks: await auditExam(records, exam.store, exam.beacons),
                at: Date.now(),
            });
        } catch (e) {
            setRun({ kind: "failed", refusal: describeError(e) });
        }
    };

    const passed =
        run.kind === "done" ? run.checks.filter((c) => c.ok).length : 0;
    return (
        <div className="page">
            <div className="wrap">
                <PageHead
                    title="Audit the whole exam from public data"
                    lead="This browser recomputes every derived value from the chain, the public store and the custodians' post-exam shares. It needs no account and trusts no server's word."
                >
                    <div className="btn-row">
                        <button
                            type="button"
                            className="btn btn--primary"
                            disabled={!ready || busy}
                            onClick={() => void audit()}
                        >
                            {run.kind === "done"
                                ? "Run the audit again"
                                : "Run the audit"}
                        </button>
                    </div>
                    {!ready ? (
                        <p className="note">
                            The audit opens the answer key, so it runs after
                            round {cfg.answersRound} is on chain (
                            {clock(roundTimeMs(exam.drand, cfg.answersRound))}).
                        </p>
                    ) : null}
                </PageHead>
                <div role="status" className="audit-status">
                    {run.kind === "collecting"
                        ? run.waiting
                            ? "Waiting for the custodians to release the answer-key shares"
                            : "Reading the chain, the store and the custodians"
                        : null}
                    {run.kind === "checking"
                        ? "Re-opening questions and recomputing every root"
                        : null}
                    {run.kind === "done" ? (
                        <p
                            className={`audit-summary ${passed === run.checks.length ? "is-done" : "is-failed"}`}
                        >
                            <Glyph
                                state={
                                    passed === run.checks.length
                                        ? "done"
                                        : "failed"
                                }
                            />
                            {passed === run.checks.length
                                ? `All ${plural(run.checks.length, "check")} pass`
                                : `${passed} of ${plural(run.checks.length, "check")} pass`}
                            <span className="audit-summary__at">
                                Run at {clock(run.at)}
                            </span>
                        </p>
                    ) : null}
                </div>
                {run.kind === "failed" ? (
                    <RefusalNote
                        refusal={run.refusal}
                        title="The audit could not finish"
                    />
                ) : null}
                {run.kind === "done" ? (
                    <ol className="audit-list">
                        {run.checks.map((c) => (
                            <li
                                key={c.name}
                                className={`audit-row is-${c.ok ? "done" : "failed"}`}
                            >
                                <Glyph state={c.ok ? "done" : "failed"} />
                                <div>
                                    <h2 className="audit-row__name">
                                        {c.name}
                                    </h2>
                                    {MEANING[c.name] ? (
                                        <p className="audit-row__meaning">
                                            {MEANING[c.name]}
                                        </p>
                                    ) : null}
                                    <p className="audit-row__detail">
                                        {c.detail}
                                    </p>
                                </div>
                            </li>
                        ))}
                    </ol>
                ) : null}
            </div>
        </div>
    );
}
