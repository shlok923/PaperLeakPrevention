import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    Buffer,
    timelockDecrypt,
    timelockEncrypt,
    type ChainClient,
} from "tlock-js";
import {
    concatBytes,
    fromHex,
    randomBytes,
    toHex,
    u64,
    type Hex,
} from "./bytes.ts";

/** drand's /info document. Field names follow the drand HTTP API. */
export interface ChainInfo {
    public_key: string;
    period: number;
    genesis_time: number;
    hash: string;
    groupHash: string;
    schemeID: "bls-unchained-g1-rfc9380";
    metadata: { beaconID: string };
}

export interface Beacon {
    round: number;
    signature: string;
}

export const DST_G1 = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

export const QUICKNET: ChainInfo = {
    public_key:
        "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
    period: 3,
    genesis_time: 1692803367,
    hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
    groupHash:
        "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
    schemeID: "bls-unchained-g1-rfc9380",
    metadata: { beaconID: "quicknet" },
};

export const roundAt = (info: ChainInfo, unixMs: number): number =>
    Math.max(
        0,
        Math.floor((unixMs / 1000 - info.genesis_time) / info.period) + 1,
    );

export const roundTimeMs = (info: ChainInfo, round: number): number =>
    (info.genesis_time + (round - 1) * info.period) * 1000;

/** The message drand signs for an unchained round: sha256(round as uint64 big-endian). */
export const roundMessage = (round: number): Uint8Array =>
    sha256(u64(BigInt(round)));

export function verifyBeacon(info: ChainInfo, beacon: Beacon): boolean {
    try {
        const msg = bls12_381.shortSignatures.hash(
            roundMessage(beacon.round),
            DST_G1,
        );
        const sig = bls12_381.G1.Point.fromHex(strip(beacon.signature));
        const pk = bls12_381.G2.Point.fromHex(strip(info.public_key));
        return bls12_381.shortSignatures.verify(sig, msg, pk);
    } catch {
        return false;
    }
}

const strip = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h);

const fp = (v: bigint): Uint8Array => {
    const out = new Uint8Array(64);
    out.set(fromHex(v.toString(16).padStart(96, "0")), 16);
    return out;
};

/** A G1 signature in the 128-byte EIP-2537 encoding the contract verifies. */
export function signatureToEip2537(signature: string): Hex {
    const p = bls12_381.G1.Point.fromHex(strip(signature)).toAffine();
    return toHex(concatBytes(fp(p.x), fp(p.y)));
}

/** A G2 public key in the 256-byte EIP-2537 encoding. */
export function publicKeyToEip2537(publicKey: string): Hex {
    const p = bls12_381.G2.Point.fromHex(strip(publicKey)).toAffine();
    return toHex(concatBytes(fp(p.x.c0), fp(p.x.c1), fp(p.y.c0), fp(p.y.c1)));
}

/** Time-lock `payload` so it opens when `info`'s network publishes `round`. Standard tlock/age armor. */
export async function tlockEncrypt(
    info: ChainInfo,
    round: number,
    payload: Uint8Array,
): Promise<string> {
    return timelockEncrypt(
        round,
        Buffer.from(payload),
        adapter(info, async () => {
            throw new Error("encryption needs no beacon");
        }),
    );
}

/**
 * Open a tlock capsule with an already verified beacon. The clock check is ours (the
 * beacon exists), so the adapter reports genesis 0 to skip tlock-js's wall-clock check.
 */
export async function tlockDecrypt(
    info: ChainInfo,
    capsule: string,
    beacon: Beacon,
): Promise<Uint8Array> {
    if (!verifyBeacon(info, beacon))
        throw new Error(`invalid beacon for round ${beacon.round}`);
    const lenient = { ...info, genesis_time: 0 };
    const out = await timelockDecrypt(
        capsule,
        adapter(lenient, async (round) => {
            if (round !== beacon.round)
                throw new Error(
                    `capsule is for round ${round}, have ${beacon.round}`,
                );
            return beacon;
        }),
    );
    return new Uint8Array(out);
}

export function capsuleRound(capsule: string): number {
    const body = capsule.includes("BEGIN AGE ENCRYPTED FILE")
        ? atob(capsule.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""))
        : capsule;
    const m = /-> tlock (\d+) /.exec(body);
    if (!m) throw new Error("not a tlock capsule");
    return Number(m[1]);
}

function adapter(
    info: ChainInfo,
    get: (round: number) => Promise<Beacon>,
): ChainClient {
    const randomness = (sig: string) => toHex(sha256(fromHex(sig))).slice(2);
    const client = {
        options: { disableBeaconVerification: true, noCache: true },
        chain: () => ({ baseUrl: "eplp://local", info: async () => info }),
        latest: async () => {
            throw new Error("latest not available");
        },
        get: async (round: number) => {
            const b = await get(round);
            return {
                round: b.round,
                signature: strip(b.signature),
                randomness: randomness(b.signature),
            };
        },
    };
    return client as unknown as ChainClient;
}

/** Where beacons come from: drand's HTTP API, a gateway relay of it, or the dev beacon. */
export interface BeaconSource {
    info(): Promise<ChainInfo>;
    get(round: number): Promise<Beacon | null>;
    latest(): Promise<Beacon>;
}

/** Reads the drand HTTP API at `baseUrl` (e.g. https://api.drand.sh/<chainHash>) and verifies every beacon. */
export function httpBeaconSource(
    baseUrl: string,
    expected?: ChainInfo,
): BeaconSource {
    let cached: ChainInfo | undefined;
    const info = async (): Promise<ChainInfo> => {
        if (cached) return cached;
        const got = (await (
            await fetch(`${baseUrl}/info`)
        ).json()) as ChainInfo;
        if (
            expected &&
            (got.public_key !== expected.public_key ||
                got.period !== expected.period ||
                got.genesis_time !== expected.genesis_time)
        ) {
            throw new Error(
                "beacon source serves a different chain than configured",
            );
        }
        cached = expected ?? got;
        return cached;
    };
    const checked = async (b: Beacon): Promise<Beacon> => {
        if (!verifyBeacon(await info(), b))
            throw new Error(`beacon ${b.round} failed verification`);
        return { round: b.round, signature: b.signature };
    };
    return {
        info,
        async get(round) {
            const res = await fetch(`${baseUrl}/public/${round}`);
            if (!res.ok) return null;
            return checked((await res.json()) as Beacon);
        },
        async latest() {
            const res = await fetch(`${baseUrl}/public/latest`);
            if (!res.ok) throw new Error(`beacon source: ${res.status}`);
            return checked((await res.json()) as Beacon);
        },
    };
}

/** A local stand-in for drand with the same scheme, for offline development and fast tests. */
export class DevBeacon {
    readonly info: ChainInfo;
    readonly #secret: Uint8Array;

    constructor(secret: Uint8Array, genesisTime: number, period: number) {
        this.#secret = secret;
        const pk = bls12_381.shortSignatures.getPublicKey(secret).toHex();
        const hash = toHex(
            sha256(
                concatBytes(
                    fromHex(pk),
                    u64(BigInt(genesisTime)),
                    u64(BigInt(period)),
                ),
            ),
        ).slice(2);
        this.info = {
            public_key: pk,
            period,
            genesis_time: genesisTime,
            hash,
            groupHash: hash,
            schemeID: "bls-unchained-g1-rfc9380",
            metadata: { beaconID: "eplp-dev" },
        };
    }

    static generateSecret(): Uint8Array {
        return bls12_381.utils.randomSecretKey(randomBytes(48));
    }

    sign(round: number): Beacon {
        const msg = bls12_381.shortSignatures.hash(roundMessage(round), DST_G1);
        return {
            round,
            signature: bls12_381.shortSignatures
                .sign(msg, this.#secret)
                .toHex(),
        };
    }

    currentRound(nowMs = Date.now()): number {
        return roundAt(this.info, nowMs);
    }
}
