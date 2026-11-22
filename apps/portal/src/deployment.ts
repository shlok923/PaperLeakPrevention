import { isAddress, type Address } from "viem";

export interface Deployment {
    rpcUrl: string;
    chainId: number;
    registry: Address;
    drandUrl: string;
    storeUrl: string;
    custodianUrls: string[];
    gatewayUrls: string[];
    portalUrl: string;
    dev: boolean;
}

const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");

export function parseDeployment(raw: unknown): Deployment {
    const d = (raw ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    const str = (k: string) =>
        typeof d[k] === "string" && d[k] !== ""
            ? (d[k] as string)
            : (problems.push(k), "");
    const rpcUrl = str("rpcUrl");
    const drandUrl = str("drandUrl");
    const storeUrl = str("storeUrl");
    const portalUrl = typeof d.portalUrl === "string" ? d.portalUrl : "";
    const registry = str("registry");
    if (registry && !isAddress(registry)) problems.push("registry");
    if (typeof d.chainId !== "number") problems.push("chainId");
    if (!strings(d.custodianUrls) || d.custodianUrls.length === 0)
        problems.push("custodianUrls");
    if (problems.length)
        throw new Error(
            `deployment.json is missing or has a bad ${problems.join(", ")}`,
        );
    return {
        rpcUrl,
        chainId: d.chainId as number,
        registry: registry as Address,
        drandUrl,
        storeUrl,
        custodianUrls: d.custodianUrls as string[],
        gatewayUrls: strings(d.gatewayUrls) ? d.gatewayUrls : [],
        portalUrl,
        dev: d.dev === true,
    };
}

export async function loadDeployment(): Promise<Deployment> {
    const res = await fetch(`${import.meta.env.BASE_URL}deployment.json`, {
        cache: "no-store",
    });
    if (!res.ok)
        throw new Error(
            `no deployment.json (${res.status}); start the stack with the dev launcher first`,
        );
    return parseDeployment(await res.json());
}
