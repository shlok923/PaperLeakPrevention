export interface UnlockProgress {
    beacon: boolean;
    released: number;
    refused: number;
    opened: number;
}

export const NO_PROGRESS: UnlockProgress = {
    beacon: false,
    released: 0,
    refused: 0,
    opened: 0,
};

type Listener = (url: string, ok: boolean) => void;
const listeners = new Set<Listener>();
let installed = false;

function install(): void {
    if (installed) return;
    installed = true;
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
        const url =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
        try {
            const res = await original(input, init);
            for (const l of listeners) l(url, res.ok);
            return res;
        } catch (e) {
            for (const l of listeners) l(url, false);
            throw e;
        }
    };
}

export function watchUnlock(onChange: (p: UnlockProgress) => void): () => void {
    install();
    let p = NO_PROGRESS;
    const listener: Listener = (url, ok) => {
        const path = new URL(url, location.origin).pathname;
        if (path.startsWith("/api/questions/")) p = { ...p, beacon: true };
        else if (path.startsWith("/api/release/"))
            p = ok
                ? { ...p, released: p.released + 1 }
                : { ...p, refused: p.refused + 1 };
        else if (path.startsWith("/api/bundles/") && ok)
            p = { ...p, opened: p.opened + 1 };
        else return;
        onChange(p);
    };
    listeners.add(listener);
    return () => listeners.delete(listener);
}
