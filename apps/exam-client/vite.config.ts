import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    base: "/",
    plugins: [react()],
    resolve: { alias: { crypto: "@eplp/protocol/browser/node-crypto" } },
    build: { outDir: "dist", target: "es2023", chunkSizeWarningLimit: 800 },
    server: {
        proxy: process.env.GATEWAY_URL
            ? {
                  "/api": {
                      target: process.env.GATEWAY_URL,
                      changeOrigin: true,
                  },
              }
            : {},
    },
});
