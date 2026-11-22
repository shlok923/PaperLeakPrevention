import { shiftLabel } from "../lib/exam.ts";
import type { Refusal } from "../lib/refusals.ts";
import { clockTime, countdown, useNow } from "../lib/time.ts";
import type { UnlockProgress } from "../lib/unlock-progress.ts";
import { Check, Notice, TopBar } from "../ui.tsx";
import type { Candidate } from "./Terminal.tsx";

type StepState = "waiting" | "active" | "done";

export function WaitingRoom({
    c,
    progress,
    refusal,
    onRetry,
    onLeave,
}: {
    c: Candidate;
    progress: UnlockProgress;
    refusal: Refusal | null;
    onRetry: () => void;
    onLeave: () => void;
}) {
    const now = useNow(250);
    const s = c.session;
    const cfg = s.exam.config;
    const startsAt = s.startTimeMs();
    const startRound = s.window.start;
    const questions = cfg.shifts[s.shift]!.perPool.reduce((a, b) => a + b, 0);
    const keyHolders = cfg.custodians.length;
    const enoughKeys = progress.released >= cfg.threshold;
    const answeredKeys = progress.released + progress.refused;

    const beaconState: StepState = progress.beacon
        ? "done"
        : now >= startsAt
          ? "active"
          : "waiting";
    const keyState: StepState = !progress.beacon
        ? "waiting"
        : answeredKeys >= keyHolders || enoughKeys
          ? "done"
          : "active";
    const paperState: StepState = keyState !== "done" ? "waiting" : "active";

    const opening = progress.beacon && !refusal;
    return (
        <div className="screen">
            <TopBar
                title={cfg.title}
                sub={`${s.exam.center.name} · ${shiftLabel(s.shift)}`}
            >
                <Identity rollNo={c.rollNo} terminalId={s.terminalId} />
            </TopBar>
            <main className="waiting enter">
                <section
                    className="waiting__clock"
                    aria-labelledby="wait-h"
                    aria-live="polite"
                >
                    {refusal ? (
                        <>
                            <h1 className="display display--md" id="wait-h">
                                Your paper is still sealed.
                            </h1>
                            <Notice refusal={refusal} />
                            <div className="btn-row">
                                <button
                                    type="button"
                                    className="btn btn--primary"
                                    onClick={onRetry}
                                >
                                    Try opening again
                                </button>
                                <button
                                    type="button"
                                    className="btn btn--secondary"
                                    onClick={onLeave}
                                >
                                    Back to check-in
                                </button>
                            </div>
                        </>
                    ) : opening ? (
                        <>
                            <p className="label">Start signal received</p>
                            <h1 className="display" id="wait-h">
                                Opening your paper.
                            </h1>
                            <p className="lead">
                                This takes a few seconds. Stay at this terminal.
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="label" id="wait-h">
                                {now < startsAt
                                    ? "Your paper opens in"
                                    : "Waiting for the start signal"}
                            </p>
                            <p
                                className="countdown"
                                role="timer"
                                aria-label={`Paper opens in ${countdown(startsAt - now)}`}
                            >
                                {countdown(startsAt - now)}
                            </p>
                            <p className="lead">
                                at{" "}
                                <span className="num">
                                    {clockTime(startsAt)}
                                </span>
                                , when the drand beacon publishes round{" "}
                                <span className="num">{startRound}</span>.
                            </p>
                        </>
                    )}
                </section>

                <section className="waiting__how panel" aria-labelledby="how-h">
                    <h2 id="how-h">
                        The paper does not exist yet.{" "}
                        <span className="muted">
                            It is put together on this screen at the start
                            signal.
                        </span>
                    </h2>
                    <ol className="stages">
                        <Stage
                            state={beaconState}
                            title="The start signal arrives"
                        >
                            {progress.beacon
                                ? `Round ${startRound} arrived and its signature checks out.`
                                : `The public drand beacon publishes round ${startRound}. No one can compute it early, and this terminal checks its signature.`}
                        </Stage>
                        <Stage
                            state={keyState}
                            title="Key holders send their shares"
                        >
                            {progress.beacon
                                ? `${progress.released} of ${keyHolders} have answered. ${cfg.threshold} are needed.`
                                : `${keyHolders} independent key holders each send a share of the keys, sealed to this terminal. Any ${cfg.threshold} are enough.`}
                        </Stage>
                        <Stage state={paperState} title="Your questions open">
                            {paperState === "active"
                                ? `${Math.min(progress.opened, questions)} of ${questions} questions opened and checked.`
                                : `The signal picks ${questions} questions from a sealed pool about twice that size. They open here, in an order made for you.`}
                        </Stage>
                    </ol>
                </section>
            </main>
        </div>
    );
}

function Stage({
    state,
    title,
    children,
}: {
    state: StepState;
    title: string;
    children: string;
}) {
    return (
        <li className="stage" data-state={state}>
            <span className="stage__mark" aria-hidden="true">
                {state === "done" && <Check />}
            </span>
            <div>
                <p className="stage__title">
                    {title}
                    <span className="sr-only">
                        {state === "done"
                            ? " (done)"
                            : state === "active"
                              ? " (in progress)"
                              : ""}
                    </span>
                </p>
                <p className="stage__text">{children}</p>
            </div>
        </li>
    );
}

export function Identity({
    rollNo,
    terminalId,
}: {
    rollNo: string;
    terminalId: string;
}) {
    return (
        <div className="identity">
            <p className="identity__roll mono">{rollNo}</p>
            <p className="identity__term">Terminal {terminalId}</p>
        </div>
    );
}
