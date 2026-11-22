import "@fontsource-variable/instrument-sans/wdth.css";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { Proctor } from "./proctor/Proctor.tsx";
import { Terminal } from "./terminal/Terminal.tsx";

const isProctor = location.pathname.replace(/\/+$/, "") === "/proctor";
document.title = isProctor ? "Proctor console" : "Exam terminal";

createRoot(document.getElementById("root")!).render(
    isProctor ? (
        <Proctor />
    ) : window.isSecureContext ? (
        <Terminal />
    ) : (
        <InsecureContext />
    ),
);

function InsecureContext() {
    const origin = location.origin;
    return (
        <main>
            <section className="solo enter" aria-label="Terminal blocked">
                <div className="solo__card solo__card--wide">
                    <p className="label">Terminal blocked</p>
                    <h1 className="display display--md">
                        This terminal cannot open papers over this connection.
                    </h1>
                    <p className="lead">
                        Papers are opened with the browser’s Web Crypto, which
                        only runs on HTTPS or on localhost. This page was opened
                        at <span className="mono">{origin}</span>, so nothing
                        can be decrypted here.
                    </p>
                    <p>
                        Ask the hall technician to serve the gateway over HTTPS,
                        or to start the kiosk browser with this origin marked as
                        trusted:
                    </p>
                    <pre className="code-block">
                        <code>{`google-chrome --kiosk \\\n  --unsafely-treat-insecure-origin-as-secure=${origin} \\\n  ${origin}/`}</code>
                    </pre>
                </div>
            </section>
        </main>
    );
}
