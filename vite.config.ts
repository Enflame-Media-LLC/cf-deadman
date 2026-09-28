import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: "apps/web",
  publicDir: false,
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(process.cwd(), "apps/web/src") } },
  build: { outDir: "public", emptyOutDir: false },
});
