export const LOCAL_PUBLIC_ENV = {
  PUBLIC_API_URL: "http://localhost:8080",
  PUBLIC_ADMIN_ORIGIN: "http://localhost:3000",
  PUBLIC_SITE_ID: "demo-wedding",
} as const;

export function astroCliCommand(argv: readonly string[]): string {
  if (argv.includes("build")) return "build";
  if (argv.includes("preview")) return "preview";
  if (argv.includes("dev")) return "dev";
  return "";
}

export function localPublicEnvPatch(options: {
  command: string;
  hasEnvFile: boolean;
  current: NodeJS.Dict<string>;
}): Record<string, string> {
  if (options.command !== "dev" || options.hasEnvFile) return {};
  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(LOCAL_PUBLIC_ENV)) {
    if (!options.current[key]) patch[key] = value;
  }
  return patch;
}
