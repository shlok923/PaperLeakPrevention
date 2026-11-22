import { combine, split } from "shamir-secret-sharing";
import type { Address } from "viem";
import {
    canonicalBytes,
    concatBytes,
    fromHex,
    fromUtf8,
    randomBytes,
    toHex,
    xor,
    type Hex,
} from "./bytes.ts";
import type { ExamConfig } from "./config.ts";
import {
    tlockDecrypt,
    tlockEncrypt,
    type Beacon,
    type ChainInfo,
} from "./drand.ts";
import { keccak, merkleRoot, tagged } from "./hash.ts";
import { open, seal, type Sealed } from "./hpke.ts";
import {
    commitAnswer,
    commitQuestion,
    slotKey,
    splitQuestion,
    type AnswerPayload,
    type Question,
    type QuestionPayload,
    type Slot,
} from "./question.ts";

interface Aead {
    iv: Hex;
    ct: Hex;
}

/** Everything a setter uploads for one question. None of it is readable before T. */
export interface Bundle {
    v: 1;
    examId: Hex;
    setter: Address;
    shift: number;
    index: number;
    q: Aead;
    a: Aead;
    tlockQ: string;
    tlockA: string;
    /** One sealed blob per custodian, in config order: shareQ || shareA. */
    shares: Sealed[];
}

export interface Leaf {
    shift: number;
    index: number;
    cQ: Hex;
    cA: Hex;
    bundleHash: Hex;
}

/** A setter's public list of slots; its Merkle root is the setter's one on-chain transaction. */
export interface Manifest {
    examId: Hex;
    setter: Address;
    leaves: Leaf[];
}

export const SHARE_BYTES = 33;

export const bundleHash = (b: Bundle): Hex => keccak(canonicalBytes(b));

/** The question id everywhere in the protocol. */
export const leafId = (examId: Hex, setter: Address, l: Leaf): Hex =>
    tagged(
        "eplp.leaf",
        slotKey({ examId, setter, shift: l.shift, index: l.index }),
        l.cQ,
        l.cA,
        l.bundleHash,
    );

export const manifestRoot = (m: Manifest): Hex =>
    merkleRoot(m.leaves.map((l) => leafId(m.examId, m.setter, l)));

const slotOf = (b: Bundle): Slot => ({
    examId: b.examId,
    setter: b.setter,
    shift: b.shift,
    index: b.index,
});

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "raw",
        raw.slice().buffer,
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
    );
}

async function aeadSeal(
    key: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array,
): Promise<Aead> {
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: iv.slice().buffer,
            additionalData: aad.slice().buffer,
        },
        await aesKey(key),
        plaintext.slice().buffer,
    );
    return { iv: toHex(iv), ct: toHex(new Uint8Array(ct)) };
}

async function aeadOpen(
    key: Uint8Array,
    box: Aead,
    aad: Uint8Array,
): Promise<Uint8Array> {
    const pt = await crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: fromHex(box.iv).slice().buffer,
            additionalData: aad.slice().buffer,
        },
        await aesKey(key),
        fromHex(box.ct).slice().buffer,
    );
    return new Uint8Array(pt);
}

export interface SealedQuestion {
    bundle: Bundle;
    leaf: Leaf;
    qid: Hex;
}

/**
 * Encrypt one question so that opening it needs both the shift's drand round
 * (time-lock layer) and `threshold` custodians (key layer). Same for the answer,
 * bound to `answersRound`.
 */
export async function sealQuestion(
    config: ExamConfig,
    drand: ChainInfo,
    slot: Slot,
    question: Question,
): Promise<SealedQuestion> {
    const shift = config.shifts[slot.shift];
    if (!shift) throw new Error(`no shift ${slot.shift}`);
    const n = config.custodians.length;
    const t = config.threshold;
    const aad = slotKey(slot);
    const { payloadQ, payloadA } = splitQuestion(question);

    const layer = async (payload: unknown, round: number) => {
        const key = randomBytes(32);
        const ka = randomBytes(32);
        const box = await aeadSeal(key, canonicalBytes(payload), aad);
        const capsule = await tlockEncrypt(drand, round, ka);
        const shares = await split(xor(key, ka), n, t);
        return { box, capsule, shares };
    };
    const q = await layer(payloadQ, shift.startRound);
    const a = await layer(payloadA, config.answersRound);

    const shares = await Promise.all(
        config.custodians.map((c, j) =>
            seal(c.hpkeKey, concatBytes(q.shares[j]!, a.shares[j]!), aad),
        ),
    );
    const bundle: Bundle = {
        v: 1,
        examId: slot.examId,
        setter: slot.setter,
        shift: slot.shift,
        index: slot.index,
        q: q.box,
        a: a.box,
        tlockQ: q.capsule,
        tlockA: a.capsule,
        shares,
    };
    const leaf: Leaf = {
        shift: slot.shift,
        index: slot.index,
        cQ: commitQuestion(slot, payloadQ),
        cA: commitAnswer(slot, payloadA),
        bundleHash: bundleHash(bundle),
    };
    return { bundle, leaf, qid: leafId(slot.examId, slot.setter, leaf) };
}

/** Custodian side: open this custodian's blob and return its two shares. */
export async function openShares(
    bundle: Bundle,
    custodianIndex: number,
    privateKey: Hex,
): Promise<{ shareQ: Hex; shareA: Hex }> {
    const blob = bundle.shares[custodianIndex];
    if (!blob)
        throw new Error(`bundle has no share for custodian ${custodianIndex}`);
    const pt = await open(privateKey, blob, slotKey(slotOf(bundle)));
    if (pt.length !== SHARE_BYTES * 2)
        throw new Error("share blob has the wrong length");
    return {
        shareQ: toHex(pt.slice(0, SHARE_BYTES)),
        shareA: toHex(pt.slice(SHARE_BYTES)),
    };
}

/** Every subset of size t, so one bad share cannot block a question when others are good. */
function* subsets<T>(
    xs: readonly T[],
    t: number,
    start = 0,
    acc: T[] = [],
): Generator<T[]> {
    if (acc.length === t) {
        yield acc;
        return;
    }
    for (let i = start; i < xs.length; i++)
        yield* subsets(xs, t, i + 1, [...acc, xs[i]!]);
}

async function openLayer(
    bundle: Bundle,
    box: Aead,
    capsule: string,
    beacon: Beacon,
    drand: ChainInfo,
    shares: readonly Hex[],
    threshold: number,
    verify: (plaintext: Uint8Array) => boolean,
): Promise<Uint8Array> {
    if (shares.length < threshold)
        throw new Error(`need ${threshold} shares, have ${shares.length}`);
    const ka = await tlockDecrypt(drand, capsule, beacon);
    const aad = slotKey(slotOf(bundle));
    for (const subset of subsets(shares, threshold)) {
        try {
            const kb = await combine(subset.map((s) => fromHex(s)));
            const pt = await aeadOpen(xor(ka, kb), box, aad);
            if (verify(pt)) return pt;
        } catch {
            // try the next subset
        }
    }
    throw new Error("no share subset opens this question to its commitment");
}

export async function openQuestion(
    bundle: Bundle,
    leaf: Leaf,
    beacon: Beacon,
    drand: ChainInfo,
    shares: readonly Hex[],
    threshold: number,
): Promise<QuestionPayload> {
    const pt = await openLayer(
        bundle,
        bundle.q,
        bundle.tlockQ,
        beacon,
        drand,
        shares,
        threshold,
        (pt) => {
            const payload = JSON.parse(fromUtf8(pt)) as QuestionPayload;
            return commitQuestion(slotOf(bundle), payload) === leaf.cQ;
        },
    );
    return JSON.parse(fromUtf8(pt)) as QuestionPayload;
}

export async function openAnswer(
    bundle: Bundle,
    leaf: Leaf,
    beacon: Beacon,
    drand: ChainInfo,
    shares: readonly Hex[],
    threshold: number,
): Promise<AnswerPayload> {
    const pt = await openLayer(
        bundle,
        bundle.a,
        bundle.tlockA,
        beacon,
        drand,
        shares,
        threshold,
        (pt) => {
            const payload = JSON.parse(fromUtf8(pt)) as AnswerPayload;
            return commitAnswer(slotOf(bundle), payload) === leaf.cA;
        },
    );
    return JSON.parse(fromUtf8(pt)) as AnswerPayload;
}

/** All slots a setter must fill, in manifest order (shift-major). */
export function setterSlots(
    config: ExamConfig,
    examId: Hex,
    setter: Address,
): Slot[] {
    const cfg = config.setters.find(
        (s) => s.account.toLowerCase() === setter.toLowerCase(),
    );
    if (!cfg) return [];
    return config.shifts.flatMap((_, shift) =>
        Array.from({ length: cfg.perShift }, (_, index) => ({
            examId,
            setter: cfg.account,
            shift,
            index,
        })),
    );
}

/** Seal a setter's whole batch. Questions fill slots in order: shift 0 first. */
export async function sealBatch(
    config: ExamConfig,
    drand: ChainInfo,
    examId: Hex,
    setter: Address,
    questions: readonly Question[],
    onProgress?: (done: number, total: number) => void,
): Promise<{ manifest: Manifest; bundles: Bundle[]; root: Hex }> {
    const slots = setterSlots(config, examId, setter);
    if (questions.length !== slots.length)
        throw new Error(
            `this setter must submit exactly ${slots.length} questions, got ${questions.length}`,
        );
    const sealed: SealedQuestion[] = [];
    for (const [i, slot] of slots.entries()) {
        sealed.push(await sealQuestion(config, drand, slot, questions[i]!));
        onProgress?.(i + 1, slots.length);
    }
    const manifest: Manifest = {
        examId,
        setter: slots[0]!.setter,
        leaves: sealed.map((s) => s.leaf),
    };
    return {
        manifest,
        bundles: sealed.map((s) => s.bundle),
        root: manifestRoot(manifest),
    };
}
