import { recoverMessageAddress, type Address, type LocalAccount } from "viem";
import { canonicalBytes, u16, utf8, type Hex } from "./bytes.ts";
import type { Beacon } from "./drand.ts";
import {
    keccak,
    MerkleTree,
    tagged,
    verifyMerkleProof,
    type MerkleProof,
} from "./hash.ts";
import type { Sealed } from "./hpke.ts";

const norm = (s: string) => s.trim().toUpperCase();

/** What links a person to the chain: never the roll number itself. */
export const candidateHash = (
    examId: Hex,
    rollNo: string,
    checkInCode: string,
): Hex =>
    tagged(
        "eplp.candidate",
        examId,
        utf8(norm(rollNo)),
        utf8("|"),
        utf8(norm(checkInCode)),
    );

export interface AllocationEntry {
    candidateHash: Hex;
    center: number;
}

/** Public per-shift list of who sits where, hashes only. Its root goes on chain. */
export interface Allocation {
    examId: Hex;
    shift: number;
    entries: AllocationEntry[];
}

export const allocationLeaf = (e: AllocationEntry): Hex =>
    tagged("eplp.alloc", e.candidateHash, u16(e.center));

export const allocationTree = (a: Allocation): MerkleTree =>
    new MerkleTree(a.entries.map(allocationLeaf));

export interface AllocationProof {
    proof: MerkleProof;
    leafCount: number;
}

export function allocationProof(
    a: Allocation,
    candidate: Hex,
    center: number,
): AllocationProof | null {
    const i = a.entries.findIndex(
        (e) => e.candidateHash === candidate && e.center === center,
    );
    return i < 0
        ? null
        : { proof: allocationTree(a).proof(i), leafCount: a.entries.length };
}

export const verifyAllocation = (
    root: Hex,
    entry: AllocationEntry,
    p: AllocationProof,
): boolean =>
    verifyMerkleProof(root, allocationLeaf(entry), p.proof, p.leafCount);

/** Signed by the center when a candidate checks in at a terminal. */
export interface RosterEntry {
    examId: Hex;
    shift: number;
    center: number;
    candidateHash: Hex;
    terminalId: string;
    session: Address;
    sessionHpke: Hex;
    /** The session this one replaces after a terminal swap, or null. */
    replaces: Address | null;
}

export const rosterEntryHash = (e: RosterEntry): Hex =>
    keccak(canonicalBytes(e));

export interface ReleaseRequest {
    entry: RosterEntry;
    centerSignature: Hex;
    allocation: AllocationProof;
    /** The verified beacon for the shift's (possibly postponed) start round. */
    beacon: Beacon;
}

export interface ShareItem {
    qid: Hex;
    share: Hex;
}

/** A custodian's signed statement of exactly what it released, to whom, at which round. */
export interface Receipt {
    examId: Hex;
    shift: number;
    custodian: number;
    candidateHash: Hex;
    session: Address;
    startRound: number;
    servedRound: number;
    qidsHash: Hex;
}

export const receiptHash = (r: Receipt): Hex => keccak(canonicalBytes(r));
export const qidsHash = (qids: readonly Hex[]): Hex =>
    keccak(canonicalBytes(qids));

export interface ReleaseReply {
    custodian: number;
    sealed: Sealed;
    receipt: Receipt;
    signature: Hex;
}

/** Hash-chained autosave entry; the final sheet commits to the chain head. */
export interface LogEntry {
    seq: number;
    prev: Hex;
    qid: Hex;
    choice: number | null;
    round: number;
}

export const GENESIS_LOG = `0x${"00".repeat(32)}` as Hex;
export const logEntryHash = (e: LogEntry): Hex => keccak(canonicalBytes(e));

export interface Sheet {
    examId: Hex;
    shift: number;
    center: number;
    candidateHash: Hex;
    session: Address;
    /** [qid, canonical option index or null], sorted by qid. */
    answers: [Hex, number | null][];
    logHead: Hex;
    submittedRound: number;
}

export interface SignedSheet {
    sheet: Sheet;
    signature: Hex;
}

export const sheetHash = (s: Sheet): Hex => keccak(canonicalBytes(s));
export const receiptCode = (hash: Hex): string =>
    hash.slice(2, 12).toUpperCase();
export const responseLeaf = (candidate: Hex, sheet: Hex): Hex =>
    tagged("eplp.resp", candidate, sheet);

export interface Result {
    candidateHash: Hex;
    shift: number;
    score: number;
    correct: number;
    wrong: number;
    unanswered: number;
    sheetHash: Hex;
}

export const resultLeaf = (r: Result): Hex => keccak(canonicalBytes(r));

export function scoreSheet(
    signed: SignedSheet,
    answerKey: ReadonlyMap<Hex, number>,
    marks: { correct: number; wrong: number },
): Result {
    let correct = 0;
    let wrong = 0;
    let unanswered = 0;
    for (const [qid, choice] of signed.sheet.answers) {
        if (choice === null) unanswered++;
        else if (answerKey.get(qid) === choice) correct++;
        else wrong++;
    }
    return {
        candidateHash: signed.sheet.candidateHash,
        shift: signed.sheet.shift,
        score: correct * marks.correct + wrong * marks.wrong,
        correct,
        wrong,
        unanswered,
        sheetHash: sheetHash(signed.sheet),
    };
}

export const signHash = (account: LocalAccount, hash: Hex): Promise<Hex> =>
    account.signMessage({ message: { raw: hash } });

export async function signerOf(
    hash: Hex,
    signature: Hex,
): Promise<Address | null> {
    try {
        return await recoverMessageAddress({
            message: { raw: hash },
            signature,
        });
    } catch {
        return null;
    }
}

export const sameAddress = (
    a: string | null | undefined,
    b: string | null | undefined,
): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();
