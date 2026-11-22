import { createPublicClient, http, type PublicClient } from "viem";
import { readExam, readSnapshot } from "@eplp/protocol";
import { auditDeployment, loadDeployment, scoreExam } from "./ops.ts";

const commands: Record<string, () => Promise<void>> = {
    async status() {
        const dep = loadDeployment();
        const client = createPublicClient({
            transport: http(dep.rpcUrl, { batch: true }),
        }) as PublicClient;
        const exam = await readExam(client, dep.registry);
        const s = await readSnapshot(client, exam);
        console.log(
            `${exam.config.title}\nregistry ${dep.registry}\nlatest verified round ${s.latestRound}, sealed ${s.sealed}`,
        );
        for (const st of s.setters)
            console.log(
                `  setter ${st.account} root ${st.root?.slice(0, 12) ?? "-"} acks ${st.acks} ${st.eligible ? "eligible" : ""}`,
            );
        s.windows.forEach((w, i) =>
            console.log(
                `  shift ${i}: rounds ${w.start}-${w.end}, allocation ${s.allocationRoots[i] ? "set" : "missing"}`,
            ),
        );
    },
    async score() {
        const r = await scoreExam(loadDeployment());
        console.log(`scored ${r.candidates} candidates, result root ${r.root}`);
    },
    async audit() {
        const checks = await auditDeployment(loadDeployment());
        for (const c of checks)
            console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
        if (!checks.every((c) => c.ok)) process.exitCode = 1;
    },
};

const cmd = process.argv[2] ?? "";
const run = commands[cmd];
if (!run) {
    console.log(
        `usage: eplp <${Object.keys(commands).join("|")}>   (start a demo with: pnpm dev)`,
    );
    process.exitCode = 1;
} else await run();
