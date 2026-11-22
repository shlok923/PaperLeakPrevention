import type { ReactNode } from "react";
import type { Refusal } from "./errors.ts";
import { short } from "./format.ts";

export function Hash({ value, n = 6 }: { value: string; n?: number }) {
    return (
        <code className="hash" title={value}>
            {short(value, n)}
        </code>
    );
}

export type State = "done" | "active" | "waiting" | "failed";

const STATE_LABEL: Record<State, string> = {
    done: "Done",
    active: "In progress",
    waiting: "Not yet",
    failed: "Failed",
};

export function Glyph({ state }: { state: State }) {
    return (
        <span
            className={`glyph glyph--${state}`}
            role="img"
            aria-label={STATE_LABEL[state]}
        >
            {state === "done" ? (
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3.5 8.5l3 3 6-7" />
                </svg>
            ) : state === "failed" ? (
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                </svg>
            ) : null}
        </span>
    );
}

export interface StepItem {
    key: string;
    state: State;
    title: string;
    detail?: ReactNode;
}

export function Steps({ items, label }: { items: StepItem[]; label: string }) {
    return (
        <ol className="steps" aria-label={label}>
            {items.map((s) => (
                <li key={s.key} className={`steps__item is-${s.state}`}>
                    <Glyph state={s.state} />
                    <div>
                        <p className="steps__title">{s.title}</p>
                        {s.detail ? (
                            <div className="steps__detail">{s.detail}</div>
                        ) : null}
                    </div>
                </li>
            ))}
        </ol>
    );
}

export function Bar({
    value,
    max,
    label,
}: {
    value: number;
    max: number;
    label: string;
}) {
    const f = max === 0 ? 0 : Math.min(1, value / max);
    return (
        <div
            className="bar"
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={value}
        >
            <span className="bar__fill" style={{ transform: `scaleX(${f})` }} />
        </div>
    );
}

export function RefusalNote({
    refusal,
    title,
}: {
    refusal: Refusal;
    title: string;
}) {
    return (
        <div className="refusal" role="alert">
            <p className="refusal__title">{title}</p>
            {refusal.code ? (
                <code className="refusal__code">{refusal.code}</code>
            ) : null}
            <p>{refusal.message}</p>
        </div>
    );
}

export function Dots({
    have,
    need,
    of,
}: {
    have: number;
    need: number;
    of: number;
}) {
    return (
        <span
            className="dots"
            role="img"
            aria-label={`${have} of ${of}, ${need} needed`}
        >
            {Array.from({ length: of }, (_, i) => (
                <i
                    key={i}
                    className={
                        i < have ? "is-on" : i < need ? "is-need" : undefined
                    }
                />
            ))}
        </span>
    );
}

export function PageHead({
    title,
    lead,
    children,
}: {
    title: string;
    lead: ReactNode;
    children?: ReactNode;
}) {
    return (
        <header className="page-head">
            <h1>{title}</h1>
            <p className="page-head__lead">{lead}</p>
            {children}
        </header>
    );
}
