import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve as honoServe } from "@hono/node-server";
import type { Hono } from "hono";
import {
    createPublicClient,
    createWalletClient,
    http,
    type Address,
    type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readExam, type ExamInfo, type Hex, type Wallet } from "@eplp/protocol";

export function env(name: string, fallback?: string): string {
    const v = process.env[name] ?? fallback;
    if (v === undefined || v === "") throw new Error(`missing env ${name}`);
    return v;
}

export const envInt = (name: string, fallback?: number): number =>
    Number(env(name, fallback?.toString()));

export function log(service: string, ...msg: unknown[]): void {
    console.log(
        `${new Date().toISOString().slice(11, 19)} [${service}]`,
        ...msg,
    );
}

export interface Chain {
    client: PublicClient;
    wallet: Wallet;
    address: Address;
}

export async function connect(rpcUrl: string, privateKey: Hex): Promise<Chain> {
    const transport = http(rpcUrl, { batch: { batchSize: 100, wait: 5 } });
    const client = createPublicClient({ transport }) as PublicClient;
    const id = await client.getChainId();
    const chain = {
        id,
        name: `eplp-${id}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
    };
    const account = privateKeyToAccount(privateKey);
    const wallet = createWalletClient({ account, chain, transport }) as Wallet;
    return {
        client: createPublicClient({ chain, transport }) as PublicClient,
        wallet,
        address: account.address,
    };
}

/** Wait until the registry is deployed and configured, then return it. */
export async function waitForExam(
    client: PublicClient,
    registry: Address,
    service: string,
): Promise<ExamInfo> {
    for (let i = 0; ; i++) {
        try {
            return await readExam(client, registry);
        } catch {
            if (i % 10 === 0)
                log(
                    service,
                    `waiting for exam at ${registry} to be configured`,
                );
            await sleep(1000);
        }
    }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openDb(path: string, schema: string): DatabaseSync {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(schema);
    return db;
}

export function readJsonFile<T>(path: string): T | null {
    return existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as T)
        : null;
}

export function writeJsonFile(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2));
}

export function serve(app: Hono, port: number, service: string): void {
    honoServe({
        fetch: app.fetch,
        port,
        hostname: process.env.HOST ?? "127.0.0.1",
    });
    log(
        service,
        `listening on http://${process.env.HOST ?? "127.0.0.1"}:${port}`,
    );
}

/** Run `fn` every `ms`, never overlapping, logging failures and continuing. */
export function every(
    ms: number,
    service: string,
    fn: () => Promise<void>,
): void {
    let lastError = "";
    const tick = async () => {
        try {
            await fn();
            lastError = "";
        } catch (e) {
            const msg =
                e instanceof Error ? e.message.split("\n")[0]! : String(e);
            if (msg !== lastError) log(service, `error: ${msg}`);
            lastError = msg;
        }
        setTimeout(tick, ms);
    };
    void tick();
}
