import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findRoot(from: string): string {
    for (let dir = from; ; dir = dirname(dir)) {
        if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
        if (dirname(dir) === dir) throw new Error(`no pnpm-workspace.yaml above ${from}`);
    }
}

/** The workspace root, found from this file rather than counted in `../` steps. */
export const repoRoot = findRoot(dirname(fileURLToPath(import.meta.url)));
