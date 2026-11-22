import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import {
    createWalletClient,
    custom,
    http,
    type Address,
    type EIP1193Provider,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { sameAddress, type ExamInfo, type Wallet } from "@eplp/protocol";
import { describeError } from "./errors.ts";
import { useExam, type Exam } from "./exam.tsx";

declare global {
    interface Window {
        ethereum?: EIP1193Provider;
    }
}

export type Role =
    | { kind: "authority" }
    | { kind: "setter"; index: number; pool: number; perShift: number }
    | { kind: "custodian"; index: number }
    | { kind: "center"; index: number }
    | { kind: "visitor" };

export function roleOf(info: ExamInfo, address: Address): Role {
    const cfg = info.config;
    if (sameAddress(info.authority, address)) return { kind: "authority" };
    const s = cfg.setters.findIndex((x) => sameAddress(x.account, address));
    if (s >= 0)
        return {
            kind: "setter",
            index: s,
            pool: cfg.setters[s]!.pool,
            perShift: cfg.setters[s]!.perShift,
        };
    const c = cfg.custodians.findIndex((x) => sameAddress(x.account, address));
    if (c >= 0) return { kind: "custodian", index: c };
    const h = cfg.centers.findIndex((x) => sameAddress(x.account, address));
    if (h >= 0) return { kind: "center", index: h };
    return { kind: "visitor" };
}

export function roleLabel(info: ExamInfo, role: Role): string {
    const cfg = info.config;
    switch (role.kind) {
        case "authority":
            return "Exam authority";
        case "setter":
            return `Setter ${role.index + 1}, ${cfg.pools[role.pool]}`;
        case "custodian":
            return `Custodian ${role.index + 1}`;
        case "center":
            return `Center, ${cfg.centers[role.index]!.name}`;
        case "visitor":
            return "No role in this exam";
    }
}

const DEV_MNEMONIC =
    "test test test test test test test test test test test junk";
const DEMO_INDEXES = 12;

export type Source = { kind: "demo"; index: number } | { kind: "injected" };

export interface Signer {
    source: Source;
    address: Address;
    role: Role;
    wallet: Wallet;
}

export interface DemoIdentity {
    index: number;
    address: Address;
    role: Role;
}

function demoWallet(exam: Exam, index: number): Wallet {
    const account = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: index });
    return createWalletClient({
        account,
        chain: exam.chain,
        transport: http(exam.dep.rpcUrl),
    }) as unknown as Wallet;
}

async function injectedWallet(exam: Exam): Promise<Wallet> {
    const eth = window.ethereum;
    if (!eth)
        throw new Error(
            "No browser wallet found. Install MetaMask, or pick a demo identity.",
        );
    const probe = createWalletClient({
        chain: exam.chain,
        transport: custom(eth),
    });
    const [address] = await probe.requestAddresses();
    if (!address) throw new Error("The wallet shared no account.");
    if ((await probe.getChainId()) !== exam.chain.id) {
        await probe.addChain({ chain: exam.chain });
        await probe.switchChain({ id: exam.chain.id });
    }
    return createWalletClient({
        account: address,
        chain: exam.chain,
        transport: custom(eth),
    }) as unknown as Wallet;
}

interface IdentityState {
    signer: Signer | null;
    demos: DemoIdentity[];
    connecting: boolean;
    error: string | null;
    pickDemo: (index: number) => void;
    connectInjected: () => Promise<boolean>;
    disconnect: () => void;
}

const IdentityContext = createContext<IdentityState | null>(null);

export function useIdentity(): IdentityState {
    const s = useContext(IdentityContext);
    if (!s) throw new Error("useIdentity outside IdentityProvider");
    return s;
}

const STORAGE_KEY = "eplp.demo-identity";

function remembered(): number | null {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return v === null ? null : Number(v);
    } catch {
        return null;
    }
}

function remember(index: number | null): void {
    try {
        if (index === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, String(index));
    } catch {
        // storage blocked
    }
}

export function IdentityProvider({ children }: { children: ReactNode }) {
    const { exam } = useExam();
    const [signer, setSigner] = useState<Signer | null>(null);
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const demos = useMemo<DemoIdentity[]>(
        () =>
            exam.dep.dev
                ? Array.from({ length: DEMO_INDEXES }, (_, index) => {
                      const address = mnemonicToAccount(DEV_MNEMONIC, {
                          addressIndex: index,
                      }).address;
                      return {
                          index,
                          address,
                          role: roleOf(exam.info, address),
                      };
                  })
                : [],
        [exam],
    );

    const pickDemo = useCallback(
        (index: number) => {
            const wallet = demoWallet(exam, index);
            const address = wallet.account.address;
            setSigner({
                source: { kind: "demo", index },
                address,
                role: roleOf(exam.info, address),
                wallet,
            });
            setError(null);
            remember(index);
        },
        [exam],
    );

    const connectInjected = useCallback(async (): Promise<boolean> => {
        setConnecting(true);
        setError(null);
        try {
            const wallet = await injectedWallet(exam);
            const address = wallet.account.address;
            setSigner({
                source: { kind: "injected" },
                address,
                role: roleOf(exam.info, address),
                wallet,
            });
            remember(null);
            return true;
        } catch (e) {
            setError(describeError(e).message);
            return false;
        } finally {
            setConnecting(false);
        }
    }, [exam]);

    const disconnect = useCallback(() => {
        setSigner(null);
        remember(null);
    }, []);

    useEffect(() => {
        const index = remembered();
        if (
            exam.dep.dev &&
            index !== null &&
            index >= 0 &&
            index < DEMO_INDEXES
        )
            pickDemo(index);
    }, [exam, pickDemo]);

    useEffect(() => {
        const eth = window.ethereum;
        if (!eth || signer?.source.kind !== "injected") return;
        const onChange = (accounts: Address[]) => {
            const next = accounts[0];
            if (!next) return setSigner(null);
            const wallet = createWalletClient({
                account: next,
                chain: exam.chain,
                transport: custom(eth),
            }) as unknown as Wallet;
            setSigner({
                source: { kind: "injected" },
                address: next,
                role: roleOf(exam.info, next),
                wallet,
            });
        };
        eth.on("accountsChanged", onChange);
        return () => eth.removeListener("accountsChanged", onChange);
    }, [signer, exam]);

    return (
        <IdentityContext.Provider
            value={{
                signer,
                demos,
                connecting,
                error,
                pickDemo,
                connectInjected,
                disconnect,
            }}
        >
            {children}
        </IdentityContext.Provider>
    );
}
