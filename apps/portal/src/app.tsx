import {
    lazy,
    Suspense,
    useEffect,
    useRef,
    useState,
    type ComponentType,
} from "react";
import { useExam } from "./exam.tsx";
import {
    roleLabel,
    useIdentity,
    type DemoIdentity,
    type Role,
} from "./identity.tsx";
import { Link, PATHS, useRoute, type Route } from "./router.tsx";
import { Hash } from "./ui.tsx";
import { Closing, Overview } from "./pages/overview.tsx";

const NAV: { route: Route; word: string }[] = [
    { route: "overview", word: "Exam" },
    { route: "setter", word: "Setters" },
    { route: "authority", word: "Authority" },
    { route: "results", word: "Results" },
    { route: "audit", word: "Audit" },
];

const PAGES: Record<Route, ComponentType> = {
    overview: Overview,
    setter: lazy(() =>
        import("./pages/setter.tsx").then((m) => ({ default: m.SetterPage })),
    ),
    authority: lazy(() =>
        import("./pages/authority.tsx").then((m) => ({
            default: m.AuthorityPage,
        })),
    ),
    results: lazy(() =>
        import("./pages/results.tsx").then((m) => ({ default: m.ResultsPage })),
    ),
    audit: lazy(() =>
        import("./pages/audit.tsx").then((m) => ({ default: m.AuditPage })),
    ),
};

export function App() {
    const route = useRoute();
    const Page = route ? PAGES[route] : NotFound;
    const { stale } = useExam();

    useEffect(() => {
        window.kit?.then((k) => k.motion.refresh()).catch(() => undefined);
    }, [route]);

    return (
        <>
            <Nav route={route} />
            {stale ? (
                <p className="stale" role="status">
                    Live data stopped updating: {stale}. The page shows the last
                    good read and keeps trying.
                </p>
            ) : null}
            <main
                id="top"
                className={route === "overview" ? "is-overview" : "is-tool"}
            >
                <Suspense fallback={null}>
                    <Page />
                </Suspense>
            </main>
            {route === "overview" ? <Closing /> : <ToolFooter />}
        </>
    );
}

function Nav({ route }: { route: Route | null }) {
    const [open, setOpen] = useState(false);
    const [panel, setPanel] = useState(false);
    const { signer } = useIdentity();
    const { exam } = useExam();

    useEffect(() => {
        setOpen(false);
        setPanel(false);
    }, [route]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            setOpen(false);
            setPanel(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    return (
        <header className={`nav nav--centre${open ? " is-open" : ""}`}>
            <div className="wrap nav__bar">
                <a className="skip-link" href="#top">
                    Skip to content
                </a>
                <Link className="nav__logo" to={PATHS.overview}>
                    <span className="mark mark--initial" aria-hidden="true">
                        E
                    </span>
                    EPLP
                </Link>
                <nav className="nav__links" aria-label="Main">
                    {NAV.map((n) => (
                        <div className="nav__item" key={n.route}>
                            <Link
                                className="nav__link"
                                to={PATHS[n.route]}
                                aria-current={
                                    route === n.route ? "page" : undefined
                                }
                            >
                                {n.word}
                            </Link>
                        </div>
                    ))}
                </nav>
                <div className="nav__actions">
                    <button
                        type="button"
                        className="nav__link nav__identity"
                        aria-expanded={panel}
                        aria-controls="identity-panel"
                        onClick={() => setPanel((p) => !p)}
                    >
                        {signer ? roleLabel(exam.info, signer.role) : "Sign in"}
                    </button>
                    <Link className="btn btn--primary" to={PATHS.results}>
                        Check your result
                    </Link>
                </div>
                <button
                    className="nav__toggle"
                    type="button"
                    aria-expanded={open}
                    aria-label="Menu"
                    onClick={() => setOpen((o) => !o)}
                >
                    <svg
                        width="18"
                        height="18"
                        viewBox="0 0 18 18"
                        aria-hidden="true"
                    >
                        {open ? (
                            <path
                                d="M4 4l10 10M14 4L4 14"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                            />
                        ) : (
                            <path
                                d="M2 5h14M2 13h14"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                            />
                        )}
                    </svg>
                </button>
            </div>
            {panel ? <IdentityPanel onClose={() => setPanel(false)} /> : null}
        </header>
    );
}

const GROUPS: { kind: Role["kind"]; title: string }[] = [
    { kind: "authority", title: "Authority" },
    { kind: "setter", title: "Setters" },
    { kind: "custodian", title: "Custodians" },
    { kind: "center", title: "Centers" },
];

function IdentityPanel({ onClose }: { onClose: () => void }) {
    const { exam } = useExam();
    const {
        signer,
        demos,
        connecting,
        error,
        pickDemo,
        connectInjected,
        disconnect,
    } = useIdentity();
    const first = useRef<HTMLButtonElement>(null);
    useEffect(() => first.current?.focus(), []);

    const choose = (d: DemoIdentity) => {
        pickDemo(d.index);
        onClose();
    };

    return (
        <div
            className="idpanel"
            id="identity-panel"
            role="dialog"
            aria-label="Choose who you act as"
        >
            <div className="wrap idpanel__grid">
                <div className="idpanel__wallet">
                    <h2 className="idpanel__title">Browser wallet</h2>
                    <p>
                        Signs with MetaMask or another injected wallet. The
                        portal adds chain {exam.chain.id} to the wallet if it is
                        missing.
                    </p>
                    <div className="btn-row">
                        <button
                            ref={first}
                            type="button"
                            className="btn btn--secondary"
                            disabled={connecting}
                            onClick={() =>
                                void connectInjected().then(
                                    (ok) => ok && onClose(),
                                )
                            }
                        >
                            {connecting
                                ? "Waiting for the wallet"
                                : "Connect a wallet"}
                        </button>
                        {signer ? (
                            <button
                                type="button"
                                className="btn btn--secondary"
                                onClick={() => (disconnect(), onClose())}
                            >
                                Sign out
                            </button>
                        ) : null}
                    </div>
                    {error ? <p className="idpanel__error">{error}</p> : null}
                    {signer ? (
                        <p className="idpanel__now">
                            Acting as {roleLabel(exam.info, signer.role)},{" "}
                            <Hash value={signer.address} n={4} />
                            {signer.source.kind === "demo"
                                ? ", a demo identity"
                                : ", from the browser wallet"}
                        </p>
                    ) : null}
                </div>
                {demos.length ? (
                    <div className="idpanel__demo">
                        <h2 className="idpanel__title">
                            Demo identities{" "}
                            <span className="badge badge--warn">
                                Development only
                            </span>
                        </h2>
                        <p>
                            Keys come from the public Anvil test mnemonic, so
                            anyone can sign as these accounts. This list appears
                            only on a dev deployment.
                        </p>
                        <div className="idpanel__groups">
                            {GROUPS.map((g) => (
                                <div key={g.kind} className="idpanel__group">
                                    <h3>{g.title}</h3>
                                    <ul>
                                        {demos
                                            .filter(
                                                (d) => d.role.kind === g.kind,
                                            )
                                            .map((d) => (
                                                <li key={d.index}>
                                                    <button
                                                        type="button"
                                                        className="idpanel__pick"
                                                        aria-pressed={
                                                            signer?.source
                                                                .kind ===
                                                                "demo" &&
                                                            signer.source
                                                                .index ===
                                                                d.index
                                                        }
                                                        onClick={() =>
                                                            choose(d)
                                                        }
                                                    >
                                                        <span>
                                                            {roleLabel(
                                                                exam.info,
                                                                d.role,
                                                            )}
                                                        </span>
                                                        <Hash
                                                            value={d.address}
                                                            n={4}
                                                        />
                                                    </button>
                                                </li>
                                            ))}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function ToolFooter() {
    const { exam } = useExam();
    return (
        <footer className="footer tool-footer">
            <div className="wrap footer__legal">
                <span>© 2026 EPLP</span>
                <span>
                    Registry <Hash value={exam.info.registry} n={4} /> on chain{" "}
                    {exam.chain.id}
                </span>
            </div>
        </footer>
    );
}

function NotFound() {
    return (
        <div className="page">
            <div className="wrap">
                <h1>No page at this address</h1>
                <p className="page-head__lead">
                    <Link className="link" to={PATHS.overview}>
                        See the exam status
                    </Link>
                </p>
            </div>
        </div>
    );
}
