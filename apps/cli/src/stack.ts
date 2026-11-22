import { join } from "node:path";
import { DATA, devKey, ROLES, ROOT, type Deployment } from "./ops.ts";
import { startBesu } from "./besu.ts";
import { httpUp, rpcUp, type Supervisor } from "./procs.ts";

export interface Ports {
    rpc: number;
    beacon: number;
    store: number;
    custodian: number;
    gateway: number;
    portal: number;
}

export const DEFAULT_PORTS: Ports = {
    rpc: 8545,
    beacon: 8780,
    store: 8781,
    custodian: 8790,
    gateway: 8800,
    portal: 5173,
};

const host = process.env.HOST ?? "127.0.0.1";
const url = (port: number) => `http://${host}:${port}`;

export function baseDeployment(
    p: Ports,
    drandUrl?: string,
    rpcUrl?: string,
): Omit<Deployment, "registry" | "chainId"> {
    return {
        rpcUrl: rpcUrl ?? url(p.rpc),
        drandUrl: drandUrl ?? url(p.beacon),
        storeUrl: url(p.store),
        custodianUrls: [0, 1, 2].map((j) => url(p.custodian + j)),
        gatewayUrls: [0, 1].map((c) => url(p.gateway + c)),
        portalUrl: url(p.portal),
    };
}

export async function startChainAndBeacon(
    sup: Supervisor,
    p: Ports,
    opts: {
        beaconPeriod: number;
        dataDir: string;
        rpcUrl?: string;
        drandUrl?: string;
        besu?: boolean;
    },
) {
    if (opts.besu) await startBesu(sup, p.rpc, opts.dataDir);
    else if (!opts.rpcUrl) {
        sup.start("anvil", "anvil", [
            "--hardfork",
            "prague",
            "--port",
            String(p.rpc),
            "--accounts",
            "20",
            "--host",
            host,
            "--silent",
        ]);
        await rpcUp(url(p.rpc));
    } else await rpcUp(opts.rpcUrl);
    if (!opts.drandUrl) {
        sup.node("beacon", "apps/beacon/src/main.ts", {
            PORT: String(p.beacon),
            BEACON_PERIOD: String(opts.beaconPeriod),
            BEACON_KEY_FILE: join(opts.dataDir, "beacon/key.json"),
        });
        await httpUp(`${url(p.beacon)}/info`);
    }
}

export async function startServices(
    sup: Supervisor,
    dep: Deployment,
    p: Ports,
    dataDir = DATA,
    centers = 2,
) {
    const common = {
        RPC_URL: dep.rpcUrl,
        REGISTRY: dep.registry,
        STORE_URL: dep.storeUrl,
        DRAND_URL: dep.drandUrl,
        HOST: host,
    };
    sup.node("store", "apps/store/src/main.ts", {
        ...common,
        PORT: String(p.store),
        STORE_DIR: join(dataDir, "store"),
    });
    await httpUp(`${dep.storeUrl}/health`);
    for (const j of [0, 1, 2]) {
        sup.node(`custodian-${j}`, "apps/custodian/src/main.ts", {
            ...common,
            INDEX: String(j),
            PORT: String(p.custodian + j),
            PRIVATE_KEY: devKey(ROLES.custodian(j)),
            HPKE_KEY_FILE: join(dataDir, "keys", `custodian-${j}.json`),
            DB: join(dataDir, `custodian-${j}`, "custodian.db"),
        });
    }
    for (let c = 0; c < centers; c++) {
        sup.node(`gateway-${c}`, "apps/gateway/src/main.ts", {
            ...common,
            CENTER_INDEX: String(c),
            PORT: String(p.gateway + c),
            PRIVATE_KEY: devKey(ROLES.center(c)),
            CUSTODIAN_URLS: dep.custodianUrls.join(","),
            DB: join(dataDir, `gateway-${c}`, "gateway.db"),
            CACHE_DIR: join(dataDir, `gateway-${c}`, "cache"),
            CLIENT_DIST: join(ROOT, "apps/exam-client/dist"),
            PROCTOR_PIN: "2468",
        });
    }
    await Promise.all([
        ...dep.custodianUrls.map((u) => httpUp(`${u}/health`)),
        ...dep.gatewayUrls
            .slice(0, centers)
            .map((u) => httpUp(`${u}/api/exam`)),
    ]);
}
