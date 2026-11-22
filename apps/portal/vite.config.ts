import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const deploymentFromEnv = (): Plugin => ({
    name: "eplp-deployment",
    configureServer(server) {
        const file = process.env.EPLP_DEPLOYMENT;
        if (!file) return;
        server.middlewares.use("/deployment.json", (_req, res) => {
            res.setHeader("content-type", "application/json");
            res.setHeader("cache-control", "no-store");
            res.end(readFileSync(file));
        });
    },
});

export default defineConfig({
    base: "/",
    plugins: [react(), deploymentFromEnv()],
    resolve: { alias: { crypto: "@eplp/protocol/browser/node-crypto" } },
    build: { outDir: "dist", target: "es2023", chunkSizeWarningLimit: 600 },
    server: {
        watch: {
            ignored: ["**/.taste-skill/**", "**/verify/**", "**/dist/**"],
        },
    },
});
