import {
    parseAbiItem,
    type Account,
    type Address,
    type Chain,
    type ContractFunctionArgs,
    type ContractFunctionName,
    type PublicClient,
    type Transport,
    type WalletClient,
} from "viem";
import { examRegistryAbi, examRegistryBytecode } from "./abi.ts";
import type { Hex } from "./bytes.ts";
import { fromAbiConfig, type ExamConfig } from "./config.ts";

export { examRegistryAbi, examRegistryBytecode };

type Abi = typeof examRegistryAbi;
type WriteName = ContractFunctionName<Abi, "nonpayable">;

export interface ExamInfo {
    registry: Address;
    authority: Address;
    examId: Hex;
    configHash: Hex;
    config: ExamConfig;
}

export async function readExam(
    client: PublicClient,
    registry: Address,
): Promise<ExamInfo> {
    const read = <N extends ContractFunctionName<Abi, "view">>(
        functionName: N,
    ) =>
        client.readContract({
            address: registry,
            abi: examRegistryAbi,
            functionName,
        } as never) as Promise<unknown>;
    const [authority, examId, configHash, raw] = await Promise.all([
        read("authority"),
        read("examId"),
        read("configHash"),
        read("getConfig"),
    ]);
    return {
        registry,
        authority: authority as Address,
        examId: examId as Hex,
        configHash: configHash as Hex,
        config: fromAbiConfig(raw as Parameters<typeof fromAbiConfig>[0]),
    };
}

export interface SetterState {
    account: Address;
    root: Hex | null;
    acks: number;
    eligible: boolean;
}

export interface Snapshot {
    latestRound: number;
    sealed: boolean;
    windows: { start: number; end: number }[];
    setters: SetterState[];
    allocationRoots: (Hex | null)[];
    centerRevoked: boolean[];
    resultRoot: Hex | null;
}

const ZERO = `0x${"00".repeat(32)}`;
const orNull = (h: Hex): Hex | null => (h === ZERO ? null : h);

export async function readSnapshot(
    client: PublicClient,
    exam: ExamInfo,
): Promise<Snapshot> {
    const c = { address: exam.registry, abi: examRegistryAbi } as const;
    const call = (functionName: string, args: unknown[] = []) =>
        client.readContract({
            ...c,
            functionName,
            args,
        } as never) as Promise<unknown>;
    const cfg = exam.config;
    const [
        latestRound,
        sealed,
        resultRoot,
        windows,
        setters,
        allocations,
        revoked,
    ] = await Promise.all([
        call("latestRound"),
        call("isSealed"),
        call("resultRoot"),
        Promise.all(cfg.shifts.map((_, i) => call("shiftWindow", [i]))),
        Promise.all(
            cfg.setters.map(async (s) => {
                const [root, acks, eligible] = await Promise.all([
                    call("setterRoot", [s.account]),
                    call("acknowledgments", [s.account]),
                    call("isEligible", [s.account]),
                ]);
                return {
                    account: s.account,
                    root: orNull(root as Hex),
                    acks: Number(acks),
                    eligible: eligible as boolean,
                };
            }),
        ),
        Promise.all(cfg.shifts.map((_, i) => call("allocationRoot", [i]))),
        Promise.all(
            cfg.centers.map((ctr) => call("centerRevoked", [ctr.account])),
        ),
    ]);
    return {
        latestRound: Number(latestRound),
        sealed: sealed as boolean,
        windows: (windows as [bigint, bigint][]).map(([s, e]) => ({
            start: Number(s),
            end: Number(e),
        })),
        setters,
        allocationRoots: (allocations as Hex[]).map(orNull),
        centerRevoked: revoked as boolean[],
        resultRoot: orNull(resultRoot as Hex),
    };
}

const beaconEvent = parseAbiItem(
    "event BeaconPosted(uint64 indexed round, bytes signature)",
);

/** Every beacon posted on chain, as round -> 128-byte EIP-2537 signature. */
export async function beaconsOnChain(
    client: PublicClient,
    registry: Address,
): Promise<Map<number, Hex>> {
    const logs = await client.getLogs({
        address: registry,
        event: beaconEvent,
        fromBlock: 0n,
        toBlock: "latest",
    });
    return new Map(
        logs.map((l) => [Number(l.args.round), l.args.signature as Hex]),
    );
}

export const centerShiftEvent = parseAbiItem(
    "event CenterShiftPosted(address indexed center, uint16 indexed shift, bytes32 rosterRoot, bytes32 responseRoot, uint32 sheets)",
);

export async function centerShifts(client: PublicClient, registry: Address) {
    const logs = await client.getLogs({
        address: registry,
        event: centerShiftEvent,
        fromBlock: 0n,
        toBlock: "latest",
    });
    return logs.map((l) => ({
        center: l.args.center as Address,
        shift: Number(l.args.shift),
        rosterRoot: l.args.rosterRoot as Hex,
        responseRoot: l.args.responseRoot as Hex,
        sheets: Number(l.args.sheets),
    }));
}

export type Wallet = WalletClient<Transport, Chain | undefined, Account>;

/**
 * Simulate, send, and wait. Simulation first so a revert surfaces as the contract's
 * custom error instead of a bare failed receipt.
 */
export async function send<N extends WriteName>(
    wallet: Wallet,
    client: PublicClient,
    registry: Address,
    functionName: N,
    args: ContractFunctionArgs<Abi, "nonpayable", N>,
): Promise<Hex> {
    const { request } = await client.simulateContract({
        account: wallet.account,
        address: registry,
        abi: examRegistryAbi,
        functionName,
        args,
    } as never);
    const hash = await wallet.writeContract(request as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
        throw new Error(`${functionName} reverted in ${hash}`);
    return hash;
}

export async function deployRegistry(
    wallet: Wallet,
    client: PublicClient,
): Promise<Address> {
    const hash = await wallet.deployContract({
        abi: examRegistryAbi,
        bytecode: examRegistryBytecode,
        args: [],
    } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress)
        throw new Error("deployment produced no contract");
    return receipt.contractAddress;
}
