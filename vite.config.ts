import { defineConfig } from "vite";

// The client builds into dist/client, which wrangler.toml's [assets] block serves
// as Workers Static Assets. The server (src/server) is bundled by Wrangler itself.
export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  server: {
    // Only used if you run `vite dev` directly; `npm run dev` uses wrangler dev
    // against the built assets instead so /ws hits the real Durable Object.
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
      "/api": { target: "http://127.0.0.1:8787" },
    },
  },
});
