import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { loadEnv } from "vite";
import { astroCliCommand, localPublicEnvPatch } from "./src/localPublicEnv.ts";

const envFiles = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
];
const hasEnvFile = envFiles.some((name) =>
  existsSync(fileURLToPath(new URL(name, import.meta.url))),
);
Object.assign(
  process.env,
  localPublicEnvPatch({
    command: astroCliCommand(process.argv),
    hasEnvFile,
    current: process.env,
  }),
);

export default defineConfig({
  integrations: [react()],
  vite: {
    define: {
      __APP_ENV__: JSON.stringify(
        loadEnv(
          astroCliCommand(process.argv) === "dev"
            ? "development"
            : "production",
          fileURLToPath(new URL(".", import.meta.url)),
          "",
        ).APP_ENV ?? "",
      ),
    },
    plugins: [tailwindcss()],
    ssr: {
      noExternal: ["@entrelacos/ui"],
    },
  },
});
