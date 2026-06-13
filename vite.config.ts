import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative base so the build works under any GitHub Pages path
  // (https://<user>.github.io/<repo>/) without knowing the repo name.
  base: "./",
  plugins: [react()],
  define: {
    // Viem needs these for browser
    "process.env": {},
    global: "globalThis",
  },
  resolve: {
    alias: {
      "@": "/src",
      // venice-x402-client (ethers/siwe) expects a Node Buffer in the browser
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    include: ["buffer"],
  },
});
