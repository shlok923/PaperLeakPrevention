import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { mnemonicToAccount } from "viem/accounts";
import type { Address } from "viem";
import {
    allocationTree,
    auditExam,
    candidateHash,
    chainInfoFromConfig,
    collectRecords,
    computeResults,
    deployRegistry,
    generateHpkeKeyPair,
    httpBeaconSource,
    keccak,
    publicKeyToEip2537,
    randomBytes,
    readExam,
    roundTimeMs,
    sealBatch,
    send,
    storeClient,
    toAbiConfig,
    toHex,
    utf8,
    validateConfig,
    type Allocation,
    type ChainInfo,
    type ExamConfig,
    type Hex,
    type HpkeKeyPair,
} from "@eplp/protocol";
import {
    connect,
    readJsonFile,
    writeJsonFile,
    type Chain,
} from "@eplp/node-kit";
import { repoRoot } from "@eplp/node-kit/root";
import { demoQuestions, SUBJECTS } from "./demo.ts";

export const ROOT = repoRoot;
export const DATA = resolve(ROOT, process.env.EPLP_DATA ?? ".data");
const DEV_MNEMONIC =
    "test test test test test test test test test test test junk";

export function devKey(index: number): Hex {
    const key = mnemonicToAccount(DEV_MNEMONIC, {
        addressIndex: index,
    }).getHdKey().privateKey;
    if (!key) throw new Error("no key");
    return toHex(key);
}

export const ROLES = {
    authority: 0,
    custodian: (j: number) => 1 + j,
    center: (c: number) => 4 + c,
    setter: (s: number) => 6 + s,
};

export const accountOf = (index: number): Address =>
    mnemonicToAccount(DEV_MNEMONIC, { addressIndex: index }).address;

export interface Deployment {
    rpcUrl: string;
    chainId: number;
    registry: Address;
    drandUrl: string;
    storeUrl: string;
    custodianUrls: string[];
    gatewayUrls: string[];
    portalUrl: string;
}

export const deploymentPath = () => join(DATA, "deployment.json");

export function loadDeployment(): Deployment {
    const d = readJsonFile<Deployment>(deploymentPath());
    if (!d)
        throw new Error(
            `no deployment at ${deploymentPath()}; run setup first`,
        );
    return d;
}

export async function custodianHpke(j: number): Promise<HpkeKeyPair> {
    const path = join(DATA, "keys", `custodian-${j}.json`);
    const existing = readJsonFile<HpkeKeyPair>(path);
    if (existing) return existing;
    const kp = await generateHpkeKeyPair();
    writeJsonFile(path, kp);
    return kp;
}

export function clientHash(dist = join(ROOT, "apps/exam-client/dist")): Hex {
    if (!existsSync(dist)) return `0x${"00".repeat(32)}`;
    const files: string[] = [];
    const walk = (d: string) =>
        readdirSync(d).forEach((f) =>
            statSync(join(d, f)).isDirectory()
                ? walk(join(d, f))
                : files.push(join(d, f)),
        );
    walk(dist);
    return keccak(
        ...files
            .sort()
            .flatMap((f) => [
                utf8(relative(dist, f)),
                new Uint8Array(readFileSync(f)),
            ]),
    );
}

export interface Timing {
    sealIn: number;
    startGap: number;
    duration: number;
    shiftGap: number;
    answersGap: number;
    lateEntry: number;
}

export interface DemoShape {
    centers: number;
    shifts: number;
    perShift: number;
    perPool: number;
}

export async function demoConfig(
    info: ChainInfo,
    nowRound: number,
    t: Timing,
    shape: DemoShape,
): Promise<ExamConfig> {
    const pools = Object.keys(SUBJECTS) as (keyof typeof SUBJECTS)[];
    const custodians = await Promise.all(
        [0, 1, 2].map(async (j) => ({
            account: accountOf(ROLES.custodian(j)),
            hpkeKey: (await custodianHpke(j)).publicKey,
        })),
    );
    const sealRound = nowRound + t.sealIn;
    const shifts = Array.from({ length: shape.shifts }, (_, i) => {
        const startRound =
            sealRound + t.startGap + i * (t.duration + t.shiftGap);
        return {
            startRound,
            endRound: startRound + t.duration,
            perPool: pools.map(() => shape.perPool),
            reserve: false,
        };
    });
    return {
        title: "National Entrance Test, demo sitting",
        pools: [...pools],
        setters: pools.flatMap((_, p) =>
            [0, 1].map((k) => ({
                account: accountOf(ROLES.setter(p * 2 + k)),
                pool: p,
                perShift: shape.perShift,
            })),
        ),
        custodians,
        threshold: 2,
        centers: Array.from({ length: shape.centers }, (_, c) => ({
            account: accountOf(ROLES.center(c)),
            name: ["Hall A, Pune", "Hall B, Nagpur"][c] ?? `Hall ${c}`,
        })),
        shifts,
        spare: 2,
        lateEntryRounds: t.lateEntry,
        sealRound,
        answersRound: shifts[shifts.length - 1]!.endRound + t.answersGap,
        marksCorrect: 4,
        marksWrong: -1,
        clientHash: clientHash(),
        drand: {
            publicKey: `0x${info.public_key}`,
            publicKeyG2: publicKeyToEip2537(info.public_key),
            genesisTime: info.genesis_time,
            period: info.period,
            chainHash: `0x${info.hash}`,
        },
    };
}

export async function setup(
    base: Omit<Deployment, "registry" | "chainId">,
    timing: Timing,
    shape: DemoShape,
): Promise<Deployment> {
    const drand = httpBeaconSource(base.drandUrl);
    const info = await drand.info();
    const now = (await drand.latest()).round;
    const config = await demoConfig(info, now, timing, shape);
    const problems = validateConfig(config);
    if (problems.length)
        throw new Error(`config invalid: ${problems.join("; ")}`);
    const authority = await connect(base.rpcUrl, devKey(ROLES.authority));
    const registry = await deployRegistry(authority.wallet, authority.client);
    await send(authority.wallet, authority.client, registry, "configure", [
        toAbiConfig(config),
    ] as never);
    const dep: Deployment = {
        ...base,
        registry,
        chainId: await authority.client.getChainId(),
    };
    writeJsonFile(deploymentPath(), dep);
    return dep;
}

export async function submitDemoSetters(
    dep: Deployment,
    log: (m: string) => void,
    only?: number[],
): Promise<void> {
    const exam = await readExam(
        (await connect(dep.rpcUrl, devKey(0))).client,
        dep.registry,
    );
    const info = chainInfoFromConfig(exam.config);
    const store = storeClient(dep.storeUrl);
    const pools = exam.config.pools as (keyof typeof SUBJECTS)[];
    await Promise.all(
        exam.config.setters.map(async (s, i) => {
            if (only && !only.includes(i)) return;
            const chain = await connect(dep.rpcUrl, devKey(ROLES.setter(i)));
            const count = s.perShift * exam.config.shifts.length;
            const questions = demoQuestions(pools[s.pool]!, count, 1000 + i);
            const { manifest, bundles, root } = await sealBatch(
                exam.config,
                info,
                exam.examId,
                chain.address,
                questions,
            );
            await send(
                chain.wallet,
                chain.client,
                dep.registry,
                "submitSetterRoot",
                [root, count],
            );
            await store.putManifest(manifest);
            for (const [k, b] of bundles.entries())
                await store.putBundle(manifest.leaves[k]!.bundleHash, b);
            log(
                `setter ${i} (${pools[s.pool]}) sealed ${count} questions in one transaction`,
            );
        }),
    );
}

export interface AdmitCard {
    rollNo: string;
    checkInCode: string;
    shift: number;
    center: number;
    centerName: string;
    startsAt: string;
}

export async function allocateDemo(
    dep: Deployment,
    perCenterPerShift: number,
): Promise<AdmitCard[]> {
    const chain = await connect(dep.rpcUrl, devKey(ROLES.authority));
    const exam = await readExam(chain.client, dep.registry);
    const info = chainInfoFromConfig(exam.config);
    const store = storeClient(dep.storeUrl);
    const cards: AdmitCard[] = [];
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    for (const [shift, s] of exam.config.shifts.entries()) {
        const entries = exam.config.centers.flatMap((ctr, center) =>
            Array.from({ length: perCenterPerShift }, (_, n) => {
                const rollNo = `NET26${shift}${center}${String(n + 1).padStart(3, "0")}`;
                const checkInCode = [...randomBytes(6)]
                    .map((b) => alphabet[b % alphabet.length])
                    .join("");
                cards.push({
                    rollNo,
                    checkInCode,
                    shift,
                    center,
                    centerName: ctr.name,
                    startsAt: new Date(
                        roundTimeMs(info, s.startRound),
                    ).toISOString(),
                });
                return {
                    candidateHash: candidateHash(
                        exam.examId,
                        rollNo,
                        checkInCode,
                    ),
                    center,
                };
            }),
        );
        const allocation: Allocation = { examId: exam.examId, shift, entries };
        await send(chain.wallet, chain.client, dep.registry, "setAllocation", [
            shift,
            allocationTree(allocation).root,
            entries.length,
        ]);
        await store.putAllocation(allocation);
    }
    writeJsonFile(join(DATA, "admit-cards.json"), cards);
    return cards;
}

export async function scoreExam(
    dep: Deployment,
): Promise<{ candidates: number; root: Hex | null }> {
    const chain: Chain = await connect(dep.rpcUrl, devKey(ROLES.authority));
    const exam = await readExam(chain.client, dep.registry);
    const store = storeClient(dep.storeUrl);
    const drand = httpBeaconSource(
        dep.drandUrl,
        chainInfoFromConfig(exam.config),
    );
    const records = await collectRecords(
        chain.client,
        exam,
        store,
        dep.custodianUrls,
    );
    const { results, root } = await computeResults(records, store, drand);
    if (!root) return { candidates: 0, root };
    await send(chain.wallet, chain.client, dep.registry, "postResults", [
        root,
        results.length,
    ]);
    await store.putResults(results);
    return { candidates: results.length, root };
}

export async function auditDeployment(dep: Deployment) {
    const chain = await connect(dep.rpcUrl, devKey(ROLES.authority));
    const exam = await readExam(chain.client, dep.registry);
    const store = storeClient(dep.storeUrl);
    const drand = httpBeaconSource(
        dep.drandUrl,
        chainInfoFromConfig(exam.config),
    );
    return auditExam(
        await collectRecords(chain.client, exam, store, dep.custodianUrls),
        store,
        drand,
    );
}
