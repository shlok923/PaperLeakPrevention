const TERMINAL_KEY = "eplp.terminalId";
const SITTING_KEY = "eplp.sitting";

function read(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string | null): void {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        /* the terminal still works */
    }
}

export const loadTerminalId = (): string | null => read(TERMINAL_KEY);
export const saveTerminalId = (id: string | null): void =>
    write(TERMINAL_KEY, id);

export interface Sitting {
    rollNo: string;
    shift: number;
    endsAtMs: number;
}

export function loadSitting(): Sitting | null {
    const raw = read(SITTING_KEY);
    if (!raw) return null;
    try {
        const s = JSON.parse(raw) as Sitting;
        return s.endsAtMs > Date.now() ? s : null;
    } catch {
        return null;
    }
}

export const saveSitting = (s: Sitting | null): void =>
    write(SITTING_KEY, s && JSON.stringify(s));
