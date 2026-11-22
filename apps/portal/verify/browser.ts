import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "@eplp/node-kit/root";
import { chromium, type Browser, type Page } from "playwright-core";

export const PORTAL = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = repoRoot;
export const OUT = join(PORTAL, "verify/out");
export const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });

export interface DeploymentFile {
    rpcUrl: string;
    registry: `0x${string}`;
    storeUrl: string;
    drandUrl: string;
    gatewayUrls: string[];
    custodianUrls: string[];
    portalUrl: string;
}

const deploymentFile = () =>
    process.env.EPLP_DEPLOYMENT ??
    join(
        resolve(ROOT, process.env.EPLP_DATA ?? ".data"),
        "portal-deployment.json",
    );

export const deployment = (): DeploymentFile =>
    JSON.parse(readFileSync(deploymentFile(), "utf8")) as DeploymentFile;

export const portalUrl = (path = "/") =>
    `${process.env.PORTAL_URL ?? deployment().portalUrl}${path}`;

export async function launch(): Promise<Browser> {
    return chromium.launch({
        executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
        headless: true,
    });
}

export async function openPage(
    browser: Browser,
    width = 1440,
    height = 900,
): Promise<{ page: Page; problems: string[] }> {
    const context = await browser.newContext({
        viewport: { width, height },
        acceptDownloads: true,
    });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", (m) => {
        if (m.type() === "error") problems.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    return { page, problems };
}

export async function shot(
    page: Page,
    name: string,
    fullPage = false,
): Promise<string> {
    const path = join(SHOTS, `${name}.png`);
    await page.screenshot({ path, fullPage });
    console.log(`    shot ${path}`);
    return path;
}

export const step = (m: string) =>
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
