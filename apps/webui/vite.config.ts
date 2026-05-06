import { defineConfig } from "vite";

const apiTarget = process.env["EMBED_AGENT_API"] ?? "http://127.0.0.1:8787";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: { outDir: "dist" },
});
