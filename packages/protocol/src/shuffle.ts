import { fromHex, u16, type Hex } from "./bytes.ts";
import { keccak, tagged } from "./hash.ts";

const u32 = (n: number) =>
    new Uint8Array([
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8) & 0xff,
        n & 0xff,
    ]);

/** Fisher-Yates driven by keccak(seed, i). Same seed, same order, on every machine. */
export function shuffle<T>(items: readonly T[], seed: Hex): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Number(BigInt(keccak(seed, u32(i))) % BigInt(i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
}

/** Per-shift seed from the shift's start beacon (128-byte EIP-2537 signature encoding). */
export const selectionSeed = (
    examId: Hex,
    shift: number,
    signature128: Hex,
): Hex => tagged("eplp.select", examId, u16(shift), signature128);

/**
 * The questions a shift opens for one pool, in the order they are tried. The first
 * `count` that decrypt and match their commitments make the paper; the rest are spares.
 */
export const poolOrder = (
    seed: Hex,
    pool: number,
    eligible: readonly Hex[],
): Hex[] => shuffle([...eligible].sort(), tagged("eplp.pool", seed, u16(pool)));

export const candidateSeed = (seed: Hex, candidateHash: Hex): Hex =>
    tagged("eplp.candidate", seed, candidateHash);

export const questionOrder = (
    seed: Hex,
    candidateHash: Hex,
    qids: readonly Hex[],
): Hex[] =>
    shuffle(
        [...qids].sort(),
        tagged("eplp.qorder", candidateSeed(seed, candidateHash)),
    );

/** Display position -> canonical option index. */
export const optionOrder = (
    seed: Hex,
    candidateHash: Hex,
    qid: Hex,
    optionCount = 4,
): number[] =>
    shuffle(
        Array.from({ length: optionCount }, (_, i) => i),
        tagged("eplp.oorder", candidateSeed(seed, candidateHash), fromHex(qid)),
    );
