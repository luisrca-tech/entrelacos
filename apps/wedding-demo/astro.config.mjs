import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
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
    plugins: [tailwindcss()],
    ssr: {
      noExternal: ["@entrelacos/ui"],
    },
  },
});
