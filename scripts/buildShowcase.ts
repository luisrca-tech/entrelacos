import { spawnSync } from "node:child_process";
import { showcaseBuildEnvironment } from "./showcaseBuildEnvironment";

const [app, environment] = process.argv.slice(2);
const publicEnvironment = showcaseBuildEnvironment(app, environment);
const directory =
  app === "landing"
    ? "landing"
    : app === "letters"
      ? "wedding-demo-cartas"
      : "wedding-demo-botanico";
const result = spawnSync(
  "bun",
  ["run", "--cwd", `apps/${directory}`, "build"],
  {
    env: { ...process.env, ...publicEnvironment },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
