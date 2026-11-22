export const short = (h: string, n = 6): string =>
    h.length <= 2 + 2 * n + 1 ? h : `${h.slice(0, 2 + n)}…${h.slice(-n)}`;

export const clock = (ms: number): string =>
    new Date(ms).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

function span(s: number): string {
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60} min`;
}

export function relative(atMs: number, nowMs: number): string {
    const s = Math.round((atMs - nowMs) / 1000);
    return s >= 0 ? `in ${span(s)}` : `${span(-s)} ago`;
}

export const plural = (n: number, one: string, many = `${one}s`): string =>
    `${n} ${n === 1 ? one : many}`;

export const ratio = (x: number): string =>
    Number.isFinite(x) ? `${x.toFixed(x % 1 === 0 ? 0 : 1)}×` : "no demand";
