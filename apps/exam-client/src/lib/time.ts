import { useEffect, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");

export const clockTime = (ms: number): string => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const countdown = (ms: number): string => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

export function useNow(everyMs = 250): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), everyMs);
        return () => clearInterval(id);
    }, [everyMs]);
    return now;
}
