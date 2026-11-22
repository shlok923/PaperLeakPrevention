import {
    encodeAbiParameters,
    keccak256,
    encodePacked,
    type Address,
} from "viem";
import type { Hex } from "./bytes.ts";
import type { ChainInfo } from "./drand.ts";

export interface SetterCfg {
    account: Address;
    pool: number;
    perShift: number;
}
export interface CustodianCfg {
    account: Address;
    hpkeKey: Hex;
}
export interface CenterCfg {
    account: Address;
    name: string;
}
export interface ShiftCfg {
    startRound: number;
    endRound: number;
    perPool: number[];
    reserve: boolean;
}
export interface DrandCfg {
    publicKey: Hex;
    publicKeyG2: Hex;
    genesisTime: number;
    period: number;
    chainHash: Hex;
}

/** Mirrors `ExamRegistry.ExamConfig` field for field; the contract hashes its ABI encoding. */
export interface ExamConfig {
    title: string;
    pools: string[];
    setters: SetterCfg[];
    custodians: CustodianCfg[];
    threshold: number;
    centers: CenterCfg[];
    shifts: ShiftCfg[];
    spare: number;
    lateEntryRounds: number;
    sealRound: number;
    answersRound: number;
    marksCorrect: number;
    marksWrong: number;
    clientHash: Hex;
    drand: DrandCfg;
}

export const examConfigAbi = [
    {
        type: "tuple",
        name: "cfg",
        components: [
            { name: "title", type: "string" },
            { name: "pools", type: "string[]" },
            {
                name: "setters",
                type: "tuple[]",
                components: [
                    { name: "account", type: "address" },
                    { name: "pool", type: "uint8" },
                    { name: "perShift", type: "uint16" },
                ],
            },
            {
                name: "custodians",
                type: "tuple[]",
                components: [
                    { name: "account", type: "address" },
                    { name: "hpkeKey", type: "bytes32" },
                ],
            },
            { name: "threshold", type: "uint8" },
            {
                name: "centers",
                type: "tuple[]",
                components: [
                    { name: "account", type: "address" },
                    { name: "name", type: "string" },
                ],
            },
            {
                name: "shifts",
                type: "tuple[]",
                components: [
                    { name: "startRound", type: "uint64" },
                    { name: "endRound", type: "uint64" },
                    { name: "perPool", type: "uint16[]" },
                    { name: "reserve", type: "bool" },
                ],
            },
            { name: "spare", type: "uint16" },
            { name: "lateEntryRounds", type: "uint32" },
            { name: "sealRound", type: "uint64" },
            { name: "answersRound", type: "uint64" },
            { name: "marksCorrect", type: "int8" },
            { name: "marksWrong", type: "int8" },
            { name: "clientHash", type: "bytes32" },
            {
                name: "drand",
                type: "tuple",
                components: [
                    { name: "publicKey", type: "bytes" },
                    { name: "publicKeyG2", type: "bytes" },
                    { name: "genesisTime", type: "uint64" },
                    { name: "period", type: "uint32" },
                    { name: "chainHash", type: "bytes32" },
                ],
            },
        ],
    },
] as const;

/** The value viem expects for the `cfg` tuple (uint64 fields as bigint). */
export function toAbiConfig(c: ExamConfig) {
    return {
        ...c,
        shifts: c.shifts.map((s) => ({
            ...s,
            startRound: BigInt(s.startRound),
            endRound: BigInt(s.endRound),
        })),
        sealRound: BigInt(c.sealRound),
        answersRound: BigInt(c.answersRound),
        drand: { ...c.drand, genesisTime: BigInt(c.drand.genesisTime) },
    };
}

type AbiConfig = ReturnType<typeof toAbiConfig>;

export function fromAbiConfig(a: {
    [K in keyof AbiConfig]: AbiConfig[K] extends readonly unknown[]
        ? readonly AbiConfig[K][number][]
        : AbiConfig[K];
}): ExamConfig {
    return {
        title: a.title,
        pools: [...a.pools],
        setters: a.setters.map((s) => ({
            account: s.account,
            pool: s.pool,
            perShift: s.perShift,
        })),
        custodians: a.custodians.map((c) => ({
            account: c.account,
            hpkeKey: c.hpkeKey,
        })),
        threshold: a.threshold,
        centers: a.centers.map((c) => ({ account: c.account, name: c.name })),
        shifts: a.shifts.map((s) => ({
            startRound: Number(s.startRound),
            endRound: Number(s.endRound),
            perPool: [...s.perPool],
            reserve: s.reserve,
        })),
        spare: a.spare,
        lateEntryRounds: a.lateEntryRounds,
        sealRound: Number(a.sealRound),
        answersRound: Number(a.answersRound),
        marksCorrect: a.marksCorrect,
        marksWrong: a.marksWrong,
        clientHash: a.clientHash,
        drand: {
            publicKey: a.drand.publicKey,
            publicKeyG2: a.drand.publicKeyG2,
            genesisTime: Number(a.drand.genesisTime),
            period: a.drand.period,
            chainHash: a.drand.chainHash,
        },
    };
}

export const configHash = (c: ExamConfig): Hex =>
    keccak256(encodeAbiParameters(examConfigAbi, [toAbiConfig(c)]));

export const examIdFor = (chainId: number, registry: Address): Hex =>
    keccak256(
        encodePacked(["uint256", "address"], [BigInt(chainId), registry]),
    );

/** Every rule the contract enforces in `configure`, checked early so a UI can explain the failure. */
export function validateConfig(c: ExamConfig): string[] {
    const errors: string[] = [];
    const unique = (xs: string[], what: string) => {
        if (new Set(xs.map((x) => x.toLowerCase())).size !== xs.length)
            errors.push(`duplicate ${what}`);
    };
    if (c.pools.length === 0) errors.push("at least one pool");
    if (c.shifts.length === 0) errors.push("at least one shift");
    if (c.pools.length > 255) errors.push("at most 255 pools");
    if (
        c.shifts.length >= 0xffff ||
        c.custodians.length >= 0xffff ||
        c.centers.length >= 0xffff
    )
        errors.push(
            "shifts, custodians and centers must each number fewer than 65535",
        );
    if (c.custodians.length < 2) errors.push("at least two custodians");
    if (c.threshold < 2 || c.threshold > c.custodians.length)
        errors.push("threshold must be between 2 and the custodian count");
    unique(
        c.setters.map((s) => s.account),
        "setter",
    );
    unique(
        c.custodians.map((s) => s.account),
        "custodian",
    );
    unique(
        c.centers.map((s) => s.account),
        "center",
    );
    for (const s of c.setters) {
        if (s.pool >= c.pools.length)
            errors.push(`setter ${s.account} has unknown pool ${s.pool}`);
        if (s.perShift < 1)
            errors.push(
                `setter ${s.account} must write at least one question per shift`,
            );
    }
    c.shifts.forEach((s, i) => {
        if (s.startRound >= s.endRound)
            errors.push(`shift ${i} must start before it ends`);
        if (s.perPool.length !== c.pools.length)
            errors.push(`shift ${i} needs a count for every pool`);
        const prev = c.shifts[i - 1];
        if (prev && prev.endRound > s.startRound)
            errors.push(`shift ${i} overlaps shift ${i - 1}`);
        s.perPool.forEach((count, pool) => {
            const supply = c.setters
                .filter((x) => x.pool === pool)
                .reduce((n, x) => n + x.perShift, 0);
            if (supply < count)
                errors.push(
                    `shift ${i} pool ${c.pools[pool]} needs ${count} but setters supply ${supply}`,
                );
        });
    });
    const first = c.shifts[0];
    const last = c.shifts[c.shifts.length - 1];
    if (first && c.sealRound >= first.startRound)
        errors.push("sealing must close before the first shift");
    if (last && c.answersRound <= last.endRound)
        errors.push("answers must unlock after the last shift ends");
    if (c.marksCorrect <= 0)
        errors.push("a correct answer must score positive");
    return errors;
}

export const questionsPerSetter = (c: ExamConfig, setter: Address): number =>
    (c.setters.find((s) => s.account.toLowerCase() === setter.toLowerCase())
        ?.perShift ?? 0) * c.shifts.length;

/** Pool supply over demand for a shift; the oversampling factor that dilutes a setter's leak. */
export function oversample(c: ExamConfig, shift: number, pool: number): number {
    const need = c.shifts[shift]?.perPool[pool] ?? 0;
    const supply = c.setters
        .filter((s) => s.pool === pool)
        .reduce((n, s) => n + s.perShift, 0);
    return need === 0 ? Infinity : supply / need;
}

/** The drand chain the exam is bound to, rebuilt from the frozen config. No network needed. */
export function chainInfoFromConfig(c: ExamConfig): ChainInfo {
    const hash = c.drand.chainHash.slice(2);
    return {
        public_key: c.drand.publicKey.slice(2),
        period: c.drand.period,
        genesis_time: c.drand.genesisTime,
        hash,
        groupHash: hash,
        schemeID: "bls-unchained-g1-rfc9380",
        metadata: { beaconID: "exam" },
    };
}
