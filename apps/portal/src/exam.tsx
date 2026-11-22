import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import {
    createPublicClient,
    defineChain,
    http,
    type Chain,
    type PublicClient,
} from "viem";
import {
    beaconsOnChain,
    centerShifts,
    chainInfoFromConfig,
    httpBeaconSource,
    readExam,
    readSnapshot,
    sameAddress,
    storeClient,
    type BeaconSource,
    type ChainInfo,
    type ExamInfo,
    type Hex,
    type Snapshot,
    type StoreClient,
} from "@eplp/protocol";
import type { Deployment } from "./deployment.ts";

export interface Exam {
    dep: Deployment;
    chain: Chain;
    client: PublicClient;
    info: ExamInfo;
    drand: ChainInfo;
    beacons: BeaconSource;
    store: StoreClient;
}

export interface CenterPosting {
    center: number;
    shift: number;
    rosterRoot: Hex;
    responseRoot: Hex;
    sheets: number;
}

export interface Live {
    snapshot: Snapshot;
    drandRound: number;
    onChain: ReadonlySet<number>;
    postings: CenterPosting[];
    fetchedAt: number;
}

export async function connectExam(dep: Deployment): Promise<Exam> {
    const chain = defineChain({
        id: dep.chainId,
        name:
            dep.chainId === 31337
                ? "Anvil (EPLP dev)"
                : `EPLP chain ${dep.chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [dep.rpcUrl] } },
    });
    const client = createPublicClient({
        chain,
        transport: http(dep.rpcUrl, { batch: true }),
    }) as PublicClient;
    const info = await readExam(client, dep.registry);
    const drand = chainInfoFromConfig(info.config);
    return {
        dep,
        chain,
        client,
        info,
        drand,
        beacons: httpBeaconSource(dep.drandUrl, drand),
        store: storeClient(dep.storeUrl),
    };
}

export async function readLive(exam: Exam): Promise<Live> {
    const [snapshot, latest, beacons, posted] = await Promise.all([
        readSnapshot(exam.client, exam.info),
        exam.beacons.latest(),
        beaconsOnChain(exam.client, exam.info.registry),
        centerShifts(exam.client, exam.info.registry),
    ]);
    const postings = posted.map((p) => ({
        center: exam.info.config.centers.findIndex((c) =>
            sameAddress(c.account, p.center),
        ),
        shift: p.shift,
        rosterRoot: p.rosterRoot,
        responseRoot: p.responseRoot,
        sheets: p.sheets,
    }));
    return {
        snapshot,
        drandRound: latest.round,
        onChain: new Set(beacons.keys()),
        postings,
        fetchedAt: Date.now(),
    };
}

interface ExamState {
    exam: Exam;
    live: Live;
    stale: string | null;
    refresh: () => Promise<void>;
}

const ExamContext = createContext<ExamState | null>(null);

export function useExam(): ExamState {
    const s = useContext(ExamContext);
    if (!s) throw new Error("useExam outside ExamProvider");
    return s;
}

const POLL_MS = 2000;

export function ExamProvider({
    exam,
    first,
    children,
}: {
    exam: Exam;
    first: Live;
    children: ReactNode;
}) {
    const [live, setLive] = useState(first);
    const [stale, setStale] = useState<string | null>(null);
    const inFlight = useRef<Promise<void> | null>(null);

    const read = useCallback(
        () =>
            readLive(exam)
                .then((l) => {
                    setLive(l);
                    setStale(null);
                })
                .catch((e: unknown) =>
                    setStale(e instanceof Error ? e.message : String(e)),
                ),
        [exam],
    );

    const refresh = useCallback(() => {
        const next = (inFlight.current ?? Promise.resolve()).then(read);
        inFlight.current = next;
        void next.finally(() => {
            if (inFlight.current === next) inFlight.current = null;
        });
        return next;
    }, [read]);

    useEffect(() => {
        const id = setInterval(() => {
            if (!inFlight.current) void refresh();
        }, POLL_MS);
        return () => clearInterval(id);
    }, [refresh]);

    return (
        <ExamContext.Provider value={{ exam, live, stale, refresh }}>
            {children}
        </ExamContext.Provider>
    );
}

export function useNow(ms = 1000): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(id);
    }, [ms]);
    return now;
}
