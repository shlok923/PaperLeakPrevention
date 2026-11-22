import "@fontsource-variable/reddit-sans";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { loadDeployment } from "./deployment.ts";
import {
    connectExam,
    ExamProvider,
    readLive,
    type Exam,
    type Live,
} from "./exam.tsx";
import { IdentityProvider } from "./identity.tsx";

type Boot =
    | { kind: "loading" }
    | { kind: "ready"; exam: Exam; live: Live }
    | { kind: "failed"; message: string };

const BOOT_RETRY_MS = 3000;

function Root() {
    const [boot, setBoot] = useState<Boot>({ kind: "loading" });
    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const attempt = async () => {
            try {
                const exam = await connectExam(await loadDeployment());
                const live = await readLive(exam);
                if (!stopped) setBoot({ kind: "ready", exam, live });
            } catch (e) {
                if (stopped) return;
                setBoot({
                    kind: "failed",
                    message: e instanceof Error ? e.message : String(e),
                });
                timer = setTimeout(attempt, BOOT_RETRY_MS);
            }
        };
        void attempt();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, []);

    if (boot.kind === "ready")
        return (
            <ExamProvider exam={boot.exam} first={boot.live}>
                <IdentityProvider>
                    <App />
                </IdentityProvider>
            </ExamProvider>
        );
    return (
        <main id="top" className="boot">
            <div className="wrap">
                <p className="nav__logo">
                    <span className="mark mark--initial" aria-hidden="true">
                        E
                    </span>
                    EPLP
                </p>
                {boot.kind === "loading" ? (
                    <p className="boot__line" role="status">
                        Reading the exam from the chain
                    </p>
                ) : (
                    <div className="refusal" role="alert">
                        <p className="refusal__title">
                            The portal could not reach the exam
                        </p>
                        <p>{boot.message}</p>
                        <p>Trying again every few seconds.</p>
                    </div>
                )}
            </div>
        </main>
    );
}

createRoot(document.body).render(
    <StrictMode>
        <Root />
    </StrictMode>,
);
