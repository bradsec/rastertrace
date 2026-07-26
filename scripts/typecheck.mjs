import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "rastertrace-typecheck-"));
const versionedImport = /(["'])(\.\.?\/[^"'?\n]+)\?v=\d+\1/g;

async function copySource(directory) {
  await cp(join(root, directory), join(temporaryRoot, directory), {
    recursive: true,
    filter: (source) => !source.endsWith("index.html"),
  });
}

try {
  await copySource("js");
  await copySource("pkg");

  const jsFiles = [];
  const collectJavaScript = async (directory) => {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collectJavaScript(path);
      else if (entry.name.endsWith(".js")) jsFiles.push(path);
    }
  };
  await collectJavaScript(join(temporaryRoot, "js"));

  for (const file of jsFiles) {
    const source = await readFile(file, "utf8");
    await writeFile(file, source.replace(versionedImport, "$1$2$1"));
  }

  const config = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
  config.include = ["js/**/*.js", "js/**/*.d.ts", "pkg/**/*.js", "pkg/**/*.d.ts"];
  await writeFile(join(temporaryRoot, "tsconfig.json"), JSON.stringify(config, null, 2));

  const tsc = join(root, "node_modules", ".bin", "tsc");
  const result = spawnSync(tsc, ["--project", join(temporaryRoot, "tsconfig.json")], {
    cwd: temporaryRoot,
    encoding: "utf8",
  });
  const rewritePath = (text) => text?.replaceAll(`${temporaryRoot}/`, "") ?? "";
  process.stdout.write(rewritePath(result.stdout));
  process.stderr.write(rewritePath(result.stderr));
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
