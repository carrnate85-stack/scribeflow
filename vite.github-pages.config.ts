import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "github-pages",
  base: "/scribeflow/",
  publicDir: "../public",
  define: {
    "import.meta.env.VITE_SCRIBEFLOW_WEB": JSON.stringify("1"),
  },
  plugins: [react()],
  build: {
    outDir: "../dist-pages",
    emptyOutDir: true,
  },
});
