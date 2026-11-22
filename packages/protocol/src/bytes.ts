import {
    bytesToHex,
    hexToBytes,
    concatBytes,
    utf8ToBytes,
} from "@noble/hashes/utils.js";

export type Hex = `0x${string}`;

export const toHex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
export const fromHex = (h: string): Uint8Array =>
    hexToBytes(h.startsWith("0x") ? h.slice(2) : h);
export const utf8 = (s: string): Uint8Array => utf8ToBytes(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
export { concatBytes };

export function randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    globalThis.crypto.getRandomValues(out);
    return out;
}

export function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length !== b.length) throw new Error("xor length mismatch");
    return a.map((v, i) => v ^ b[i]!);
}

export function u16(n: number): Uint8Array {
    return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

export function u64(n: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, n);
    return out;
}

export function b64(b: Uint8Array): string {
    let s = "";
    for (const c of b) s += String.fromCharCode(c);
    return btoa(s);
}

export function fromB64(s: string): Uint8Array {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Deterministic JSON: sorted keys, no whitespace. Only plain data (no undefined, no bigint). */
export function canonicalJson(value: unknown): string {
    if (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "string"
    )
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error("non-finite number in canonical JSON");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    throw new Error(`unsupported value in canonical JSON: ${typeof value}`);
}

export const canonicalBytes = (value: unknown): Uint8Array =>
    utf8(canonicalJson(value));
