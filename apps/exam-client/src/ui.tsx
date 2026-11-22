import type { InputHTMLAttributes, ReactNode } from "react";
import type { Refusal } from "./lib/refusals.ts";

export function TopBar({
    title,
    sub,
    children,
}: {
    title: string;
    sub: string;
    children?: ReactNode;
}) {
    return (
        <header className="bar">
            <div className="bar__brand">
                <Mark />
                <div>
                    <p className="bar__title">{title}</p>
                    <p className="bar__sub">{sub}</p>
                </div>
            </div>
            {children && <div className="bar__end">{children}</div>}
        </header>
    );
}

export function Notice({
    refusal,
    tone = "error",
}: {
    refusal: Refusal;
    tone?: "error" | "info";
}) {
    return (
        <div
            className={`notice notice--${tone}`}
            role={tone === "error" ? "alert" : "status"}
        >
            <p className="notice__title">{refusal.title}</p>
            <p className="notice__detail">{refusal.detail}</p>
        </div>
    );
}

export function Field({
    id,
    label,
    error,
    hint,
    ...input
}: {
    id: string;
    label: string;
    error?: string | undefined;
    hint?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
    const describedBy =
        [error && `${id}-error`, hint && `${id}-hint`]
            .filter(Boolean)
            .join(" ") || undefined;
    return (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            <input
                id={id}
                name={id}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy}
                {...input}
            />
            {hint && !error && (
                <p className="field__hint" id={`${id}-hint`}>
                    {hint}
                </p>
            )}
            {error && (
                <p className="field__error" id={`${id}-error`}>
                    {error}
                </p>
            )}
        </div>
    );
}

export const Mark = () => (
    <svg
        className="mark"
        viewBox="0 0 28 28"
        width="28"
        height="28"
        aria-hidden="true"
    >
        <circle cx="5" cy="14" r="3.5" fill="currentColor" />
        <circle cx="14" cy="14" r="3.5" fill="currentColor" />
        <circle
            cx="23"
            cy="14"
            r="3"
            fill="var(--accent)"
            stroke="currentColor"
            strokeWidth="1.2"
        />
    </svg>
);

export const Check = () => (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path
            d="M3.5 8.5l3 3 6-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

export const Arrow = ({ back = false }: { back?: boolean }) => (
    <svg
        className={`m-arrow${back ? " m-arrow--back" : ""}`}
        viewBox="0 0 16 16"
        width="16"
        height="16"
        aria-hidden="true"
    >
        <path
            d={back ? "M13 8H3m4-4L3 8l4 4" : "M3 8h10m-4-4 4 4-4 4"}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

export const Flag = () => (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path
            d="M4 14V2.5m0 .5h7.5l-1.8 3 1.8 3H4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);
