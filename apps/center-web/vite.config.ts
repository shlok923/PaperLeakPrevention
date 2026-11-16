import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const workspaceDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: { target: "esnext" },
  optimizeDeps: { exclude: ["libsodium-wrappers"] },
  resolve: {
    alias: [
      {
        find: /^\.\/libsodium\.mjs$/,
        replacement: path.resolve(workspaceDir, "../../node_modules/libsodium/dist/modules-esm/libsodium.mjs"),
      },
    ],
  },
  server: {
    proxy: {
      "/v1": "http://127.0.0.1:3000",
      ...Object.fromEntries([1, 2, 3, 4, 5].map((index) => [`/key-holder-${index}`, {
        target: `http://127.0.0.1:${3000 + index}`,
        rewrite: (path: string) => path.replace(new RegExp(`^/key-holder-${index}`), ""),
      }])),
    },
  },
});
