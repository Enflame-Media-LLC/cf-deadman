import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: "apps/web",
  plugins: [vue()],
  build: { outDir: "dist" },
});
