/** Stands in for Node's `crypto` in browser builds. tlock-js only reaches it when `window.crypto` is missing. */
export function randomBytes(n: number): Uint8Array {
    return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
export default { randomBytes };
