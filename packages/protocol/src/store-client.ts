import type { Address } from "viem";
import type { Hex } from "./bytes.ts";
import type { Bundle, Manifest } from "./bundle.ts";
import type { Snapshot } from "./chain.ts";
import type { ExamConfig } from "./config.ts";
import type {
    Allocation,
    Result,
    SignedSheet,
    Receipt,
    RosterEntry,
} from "./session.ts";
import {
    checkManifest,
    eligibleQuestions,
    type EligibleQuestion,
} from "./state.ts";

export class HttpError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(status: number, message: string, body: string) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
        const body = await res.text();
        throw new HttpError(
            res.status,
            `${init?.method ?? "GET"} ${url}: ${res.status} ${body}`,
            body,
        );
    }
    return (await res.json()) as T;
}

export const postJson = <T>(
    url: string,
    body: unknown,
    method = "POST",
): Promise<T> =>
    getJson<T>(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

export interface SignedReceipt {
    receipt: Receipt;
    signature: Hex;
}

export interface SignedRosterEntry {
    entry: RosterEntry;
    centerSignature: Hex;
}

/** The public store. Every write is checked by the store against an on-chain root. */
export function storeClient(base: string) {
    return {
        putManifest: (m: Manifest) =>
            postJson(`${base}/manifests/${m.setter}`, m, "PUT"),
        manifest: (setter: Address) =>
            getJson<Manifest>(`${base}/manifests/${setter}`),
        putBundle: (hash: Hex, b: Bundle) =>
            postJson(`${base}/bundles/${hash}`, b, "PUT"),
        bundle: (hash: Hex) => getJson<Bundle>(`${base}/bundles/${hash}`),
        hasBundles: (hashes: Hex[]) =>
            postJson<{ missing: Hex[] }>(`${base}/bundles/missing`, hashes),
        putAllocation: (a: Allocation) =>
            postJson(`${base}/allocations/${a.shift}`, a, "PUT"),
        allocation: (shift: number) =>
            getJson<Allocation>(`${base}/allocations/${shift}`),
        putSheets: (center: number, shift: number, sheets: SignedSheet[]) =>
            postJson(`${base}/sheets/${center}/${shift}`, sheets, "PUT"),
        sheets: (center: number, shift: number) =>
            getJson<SignedSheet[]>(`${base}/sheets/${center}/${shift}`),
        putRoster: (
            center: number,
            shift: number,
            roster: SignedRosterEntry[],
        ) => postJson(`${base}/rosters/${center}/${shift}`, roster, "PUT"),
        roster: (center: number, shift: number) =>
            getJson<SignedRosterEntry[]>(`${base}/rosters/${center}/${shift}`),
        putReceipts: (
            custodian: number,
            shift: number,
            receipts: SignedReceipt[],
        ) =>
            postJson(`${base}/receipts/${custodian}/${shift}`, receipts, "PUT"),
        receipts: (custodian: number, shift: number) =>
            getJson<SignedReceipt[]>(`${base}/receipts/${custodian}/${shift}`),
        putResults: (results: Result[]) =>
            postJson(`${base}/results`, results, "PUT"),
        results: () => getJson<Result[]>(`${base}/results`),
    };
}

export type StoreClient = ReturnType<typeof storeClient>;

/** Manifests of every eligible setter, each checked against its on-chain root. */
export async function loadEligible(
    config: ExamConfig,
    snapshot: Snapshot,
    fetchManifest: (setter: Address) => Promise<Manifest>,
): Promise<{ manifests: Manifest[]; questions: Map<Hex, EligibleQuestion> }> {
    const eligible = snapshot.setters.filter((s) => s.eligible && s.root);
    const manifests = await Promise.all(
        eligible.map(async (s) => {
            const m = await fetchManifest(s.account);
            checkManifest(m, s.root!);
            return m;
        }),
    );
    return { manifests, questions: eligibleQuestions(config, manifests) };
}
