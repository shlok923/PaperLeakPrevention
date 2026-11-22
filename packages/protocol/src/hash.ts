import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, fromHex, toHex, utf8, type Hex } from "./bytes.ts";

type Part = Uint8Array | Hex;

const asBytes = (p: Part): Uint8Array =>
    typeof p === "string" ? fromHex(p) : p;

export const keccak = (...parts: Part[]): Hex =>
    toHex(keccak_256(concatBytes(...parts.map(asBytes))));

/** keccak over a domain tag followed by the parts, so hashes from different contexts never collide. */
export const tagged = (tag: string, ...parts: Part[]): Hex =>
    keccak(utf8(tag), ...parts);

export interface MerkleProof {
    index: number;
    siblings: Hex[];
}

const leafHash = (leaf: Hex): Hex => keccak(new Uint8Array([0]), leaf);
const nodeHash = (l: Hex, r: Hex): Hex => keccak(new Uint8Array([1]), l, r);

/**
 * Positional binary Merkle tree. Leaves are hashed with a 0x00 prefix and inner
 * nodes with 0x01. An odd node at the end of a level is promoted unchanged.
 */
export class MerkleTree {
    readonly levels: Hex[][];

    constructor(leaves: readonly Hex[]) {
        if (leaves.length === 0) throw new Error("empty Merkle tree");
        const levels: Hex[][] = [leaves.map(leafHash)];
        while (levels[levels.length - 1]!.length > 1) {
            const prev = levels[levels.length - 1]!;
            const next: Hex[] = [];
            for (let i = 0; i < prev.length; i += 2) {
                next.push(
                    i + 1 < prev.length
                        ? nodeHash(prev[i]!, prev[i + 1]!)
                        : prev[i]!,
                );
            }
            levels.push(next);
        }
        this.levels = levels;
    }

    get root(): Hex {
        return this.levels[this.levels.length - 1]![0]!;
    }

    proof(index: number): MerkleProof {
        const siblings: Hex[] = [];
        let i = index;
        for (const level of this.levels.slice(0, -1)) {
            const sib = i ^ 1;
            if (sib < level.length) siblings.push(level[sib]!);
            i >>= 1;
        }
        return { index, siblings };
    }
}

export const merkleRoot = (leaves: readonly Hex[]): Hex =>
    new MerkleTree(leaves).root;

export function verifyMerkleProof(
    root: Hex,
    leaf: Hex,
    proof: MerkleProof,
    leafCount: number,
): boolean {
    let hash = leafHash(leaf);
    let i = proof.index;
    let width = leafCount;
    let s = 0;
    if (i < 0 || i >= leafCount) return false;
    while (width > 1) {
        const sib = i ^ 1;
        if (sib < width) {
            const sibling = proof.siblings[s++];
            if (!sibling) return false;
            hash =
                i % 2 === 0 ? nodeHash(hash, sibling) : nodeHash(sibling, hash);
        }
        i >>= 1;
        width = Math.ceil(width / 2);
    }
    return (
        s === proof.siblings.length && hash.toLowerCase() === root.toLowerCase()
    );
}
