import {
    useSyncExternalStore,
    type AnchorHTMLAttributes,
    type MouseEvent,
} from "react";

export type Route = "overview" | "setter" | "authority" | "results" | "audit";

export const PATHS: Record<Route, string> = {
    overview: "/",
    setter: "/setter",
    authority: "/authority",
    results: "/results",
    audit: "/audit",
};

const byPath = new Map(
    Object.entries(PATHS).map(([route, path]) => [path, route as Route]),
);

const subscribe = (cb: () => void) => {
    window.addEventListener("popstate", cb);
    return () => window.removeEventListener("popstate", cb);
};

export function useRoute(): Route | null {
    const path = useSyncExternalStore(
        subscribe,
        () => window.location.pathname.replace(/\/+$/, "") || "/",
    );
    return byPath.get(path) ?? null;
}

export function navigate(path: string): void {
    if (path === window.location.pathname + window.location.hash) return;
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    if (!path.includes("#")) window.scrollTo(0, 0);
}

export function Link({
    to,
    onClick,
    ...rest
}: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
    const click = (e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (
            e.defaultPrevented ||
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
        )
            return;
        e.preventDefault();
        navigate(to);
    };
    return <a href={to} onClick={click} {...rest} />;
}
