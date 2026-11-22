import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./ops.ts";

export interface Proc {
    name: string;
    child: ChildProcess;
}

export class Supervisor {
    readonly procs: Proc[] = [];
    readonly logDir: string;
    readonly echo: boolean;

    constructor(logDir: string, echo = false) {
        this.logDir = logDir;
        this.echo = echo;
        mkdirSync(logDir, { recursive: true });
        const stop = () => {
            this.stopAll();
            process.exit(130);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        process.once("exit", () => this.stopAll());
    }

    start(
        name: string,
        cmd: string,
        args: string[],
        env: Record<string, string> = {},
        cwd = ROOT,
    ): Proc {
        const child = spawn(cmd, args, {
            cwd,
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
        });
        const out = createWriteStream(join(this.logDir, `${name}.log`));
        const pipe = (data: Buffer) => {
            out.write(data);
            if (this.echo)
                for (const line of data
                    .toString()
                    .split("\n")
                    .filter((l) => l.trim() && !l.includes("beacon received")))
                    console.log(`  ${name.padEnd(12)} ${line}`);
        };
        child.stdout!.on("data", pipe);
        child.stderr!.on("data", pipe);
        child.on("exit", (code) => {
            if (code && code !== 143 && code !== 130)
                console.error(
                    `  ${name} exited with code ${code}; see ${join(this.logDir, `${name}.log`)}`,
                );
        });
        const p = { name, child };
        this.procs.push(p);
        return p;
    }

    node(name: string, script: string, env: Record<string, string>): Proc {
        return this.start(
            name,
            process.execPath,
            ["--disable-warning=ExperimentalWarning", join(ROOT, script)],
            env,
        );
    }

    stopAll(): void {
        for (const p of this.procs.reverse()) {
            if (p.child.exitCode !== null || !p.child.pid) continue;
            try {
                process.kill(-p.child.pid, "SIGTERM");
            } catch {
                p.child.kill("SIGTERM");
            }
        }
        this.procs.length = 0;
    }
}

export async function waitFor<T>(
    what: string,
    fn: () => Promise<T | null | undefined | false>,
    timeoutMs = 120_000,
    everyMs = 500,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
        try {
            const v = await fn();
            if (v) return v;
        } catch (e) {
            last = e instanceof Error ? e.message : String(e);
        }
        if (Date.now() > deadline)
            throw new Error(
                `timed out waiting for ${what}${last ? `: ${last}` : ""}`,
            );
        await new Promise((r) => setTimeout(r, everyMs));
    }
}

export const httpUp = (url: string) =>
    waitFor(`${url}`, async () => (await fetch(url)).ok, 60_000);

export async function rpcUp(url: string): Promise<void> {
    await waitFor(
        `chain at ${url}`,
        async () => {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
            });
            return res.ok;
        },
        60_000,
    );
}
