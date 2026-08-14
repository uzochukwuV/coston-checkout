import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_BASE = process.env.VITE_API_BASE ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": "/src" },
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: [
      "work-1-tmobgtqtfytgtzja.prod-runtime.all-hands.dev",
      "work-2-tmobgtqtfytgtzja.prod-runtime.all-hands.dev",
    ],
    proxy: {
      "/api": {
        target: API_BASE,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
