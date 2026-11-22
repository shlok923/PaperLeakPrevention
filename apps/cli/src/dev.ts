import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { QUICKNET } from "@eplp/protocol";
import { allocateDemo, DATA, ROOT, setup, submitDemoSetters } from "./ops.ts";
import { Supervisor, httpUp } from "./procs.ts";
import {
    baseDeployment,
    DEFAULT_PORTS,
    startChainAndBeacon,
    startServices,
} from "./stack.ts";

const { values } = parseArgs({
    options: {
        fresh: { type: "boolean", default: false },
        quicknet: { type: "boolean", default: false },
        besu: { type: "boolean", default: false },
        rpc: { type: "string" },
        "seal-in": { type: "string", default: "180" },
        "start-gap": { type: "string", default: "60" },
        duration: { type: "string", default: "600" },
        "manual-setters": { type: "string", default: "0" },
        "no-allocate": { type: "boolean", default: false },
        "no-portal": { type: "boolean", default: false },
        offset: { type: "string", default: "0" },
    },
});

const offset = Number(values.offset);
const p = Object.fromEntries(
    Object.entries(DEFAULT_PORTS).map(([k, v]) => [k, v + offset]),
) as typeof DEFAULT_PORTS;
if (values.fresh || !values.rpc) rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const sup = new Supervisor(join(DATA, "logs"), true);

const drandUrl = values.quicknet
    ? `https://api.drand.sh/${QUICKNET.hash}`
    : undefined;
await startChainAndBeacon(sup, p, {
    beaconPeriod: 1,
    dataDir: DATA,
    besu: values.besu!,
    ...(values.rpc ? { rpcUrl: values.rpc } : {}),
    ...(drandUrl ? { drandUrl } : {}),
});
const period = values.quicknet ? 3 : 1;
const rounds = (s: string) => Math.ceil(Number(s) / period);
const dep = await setup(
    baseDeployment(p, drandUrl, values.rpc),
    {
        sealIn: rounds(values["seal-in"]!),
        startGap: rounds(values["start-gap"]!),
        duration: rounds(values.duration!),
        shiftGap: rounds("30"),
        answersGap: rounds("30"),
        lateEntry: rounds("120"),
    },
    { centers: 2, shifts: 2, perShift: 5, perPool: 5 },
);
await startServices(sup, dep, p);

if (
    existsSync(join(ROOT, "apps/portal/package.json")) &&
    !values["no-portal"]
) {
    const portalDeployment = join(DATA, "portal-deployment.json");
    writeFileSync(
        portalDeployment,
        JSON.stringify({ ...dep, dev: true }, null, 2),
    );
    sup.start(
        "portal",
        "pnpm",
        [
            "exec",
            "vite",
            "--port",
            String(p.portal),
            "--strictPort",
            "--host",
            process.env.HOST ?? "127.0.0.1",
        ],
        { EPLP_DEPLOYMENT: portalDeployment },
        join(ROOT, "apps/portal"),
    );
    await httpUp(dep.portalUrl);
}

const manual = values["manual-setters"]!.split(",").filter(Boolean).map(Number);
await submitDemoSetters(
    dep,
    (m) => console.log(`  demo         ${m}`),
    [0, 1, 2, 3, 4, 5].filter((i) => !manual.includes(i)),
);
const cards = values["no-allocate"] ? [] : await allocateDemo(dep, 4);

console.log(`
EPLP demo is running.
  Portal (authority, setters, results, audit)  ${dep.portalUrl}
  Hall A exam terminals                         ${dep.gatewayUrls[0]}/
  Hall B exam terminals                         ${dep.gatewayUrls[1]}/
  Proctor console (PIN 2468)                    ${dep.gatewayUrls[0]}/proctor
  Chain RPC ${dep.rpcUrl}  registry ${dep.registry}${values.besu ? " (4 Besu QBFT validators)" : " (Anvil)"}
  drand ${dep.drandUrl}${values.quicknet ? " (League of Entropy quicknet)" : " (local dev beacon)"}
${manual.length ? `  Setters left for the portal: ${manual.join(", ")}\n` : ""}
Admit cards (also in ${join(DATA, "admit-cards.json")}):
${cards.map((c) => `  shift ${c.shift}  ${c.centerName.padEnd(15)} roll ${c.rollNo}  code ${c.checkInCode}  starts ${c.startsAt}`).join("\n")}

Ctrl-C stops everything.`);
await new Promise(() => undefined);
