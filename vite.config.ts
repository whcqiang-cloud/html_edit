import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望相对路径，且使用固定的开发端口
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2020",
    outDir: "dist",
  },
});
