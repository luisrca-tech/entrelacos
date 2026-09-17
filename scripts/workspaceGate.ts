import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function missingWorkspaceEntries(
  workspacePaths: readonly string[],
  lockfile: string,
): string[] {
  return workspacePaths.filter(
    (workspacePath) =>
      !new RegExp(`"${escapePattern(workspacePath)}"\\s*:`).test(lockfile),
  );
}

function packageDirectories(repositoryRoot: string): string[] {
  const directories: string[] = [];
  for (const parent of ["apps", "packages"]) {
    const parentPath = join(repositoryRoot, parent);
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(parentPath, entry.name);
      if (existsSync(join(directory, "package.json"))) {
        directories.push(
          relative(repositoryRoot, directory).replaceAll("\\", "/"),
        );
      }
    }
  }
  return directories.sort();
}

export function verifyWorkspaceDiscovery(repositoryRoot: string): string[] {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  ) as { workspaces?: unknown };
  const workspaces = packageJson.workspaces;
  const errors: string[] = [];
  if (
    !Array.isArray(workspaces) ||
    !workspaces.includes("apps/*") ||
    !workspaces.includes("packages/*")
  ) {
    errors.push("Root workspaces must include apps/* and packages/*");
  }

  const directories = packageDirectories(repositoryRoot);
  const names = new Set<string>();
  for (const directory of directories) {
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, directory, "package.json"), "utf8"),
    ) as { name?: unknown };
    if (typeof manifest.name !== "string" || !manifest.name) {
      errors.push(`${directory}: package name is missing`);
    } else if (names.has(manifest.name)) {
      errors.push(`${directory}: duplicate package name ${manifest.name}`);
    } else {
      names.add(manifest.name);
    }
  }

  const lockfile = readFileSync(join(repositoryRoot, "bun.lock"), "utf8");
  for (const directory of missingWorkspaceEntries(directories, lockfile)) {
    errors.push(`${directory}: workspace is absent from bun.lock`);
  }
  return errors;
}

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const errors = verifyWorkspaceDiscovery(repositoryRoot);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("All app and package workspaces are declared and locked");
  }
}
