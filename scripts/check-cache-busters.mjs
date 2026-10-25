// Check that every ?v= asset URL changed with its file, against the
// recorded scripts/cache-busters.json. With --fix, bump stale versions
// (cascading to the files that reference them) and record the result.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  checkReferences,
  collectReferences,
  fixReferences,
  hashContent,
} from "./cache-busters.mjs";

const root = new URL("../", import.meta.url);
const manifestPath = new URL("scripts/cache-busters.json", root);
const read = (file) => readFileSync(new URL(file, root));

const scanned = [
  "index.html",
  "sw.js",
  "site.webmanifest",
  ...readdirSync(new URL("js/", root))
    .filter((f) => f.endsWith(".js"))
    .map((f) => `js/${f}`),
  ...readdirSync(new URL("css/", root))
    .filter((f) => f.endsWith(".css"))
    .map((f) => `css/${f}`),
];
const sources = Object.fromEntries(scanned.map((file) => [file, read(file).toString("utf8")]));
let manifest = {};
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  // First run: everything reports as unrecorded until --fix.
}

if (process.argv.includes("--fix")) {
  const result = fixReferences(sources, read, manifest);
  for (const [file, text] of Object.entries(result.sources)) {
    if (text !== sources[file]) writeFileSync(new URL(file, root), text);
  }
  writeFileSync(manifestPath, JSON.stringify(result.manifest, null, 2) + "\n");
  console.log(
    result.bumped.length
      ? `Bumped: ${result.bumped.join(", ")}. Manifest updated.`
      : "No bumps needed. Manifest updated.",
  );
} else {
  const hashOf = (target) => hashContent(target in sources ? sources[target] : read(target));
  const problems = checkReferences(collectReferences(sources), hashOf, manifest);
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error("\nRun `npm run fix:cache-busters` to bump and record them.");
    process.exit(1);
  }
  console.log("Cache busters match their files.");
}
