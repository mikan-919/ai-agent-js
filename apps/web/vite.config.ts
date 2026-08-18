import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/app/",
  plugins: [tailwindcss(), react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
