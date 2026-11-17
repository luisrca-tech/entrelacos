import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => ({
  // PUBLIC_GIFT_PAYMENTS_ENABLED is shared with the public sites (see
  // @entrelacos/ui giftPayments); PUBLIC_* values are public by convention.
  envPrefix: ["VITE_", "PUBLIC_"],
  define: {
    __APP_ENV__: JSON.stringify(loadEnv(mode, process.cwd(), "").APP_ENV ?? ""),
  },
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    react(),
  ],
}));
