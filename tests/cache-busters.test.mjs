import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkReferences,
  collectReferences,
  fixReferences,
  hashContent,
} from "../scripts/cache-busters.mjs";

const v1 = {
  "index.html": '<script src="js/app.js?v=1"></script>',
  "js/app.js": 'import "./palette-ui.js?v=1";\nimport "./context.js?v=1";',
  "js/palette-ui.js": 'import "./context.js?v=1";',
  "js/context.js": "export const state = {};",
};
const record = (sources) =>
  Object.fromEntries(
    collectReferences(sources).map(({ target, version }) => [
      target,
      { v: version, sha: hashContent(sources[target]) },
    ]),
  );
const hashIn = (sources) => (target) => hashContent(sources[target]);
const noDisk = () => {
  throw new Error("unexpected disk read");
};

test("collectReferences resolves targets relative to the referencing file", () => {
  assert.deepEqual(
    collectReferences({ "js/worker.js": 'new URL("../pkg/x_bg.wasm?v=4", import.meta.url)' }),
    [{ from: "js/worker.js", target: "pkg/x_bg.wasm", version: 4 }],
  );
});

test("a module whose import line changed without its own bump is reported", () => {
  // The 1.1.88 bug: context.js was bumped, palette-ui.js imported the new
  // version, but palette-ui.js kept v=1 and stayed cached.
  const manifest = record(v1);
  const next = {
    ...v1,
    "js/app.js": 'import "./palette-ui.js?v=1";\nimport "./context.js?v=2";',
    "js/palette-ui.js": 'import "./context.js?v=2";',
    "js/context.js": "export const state = { changed: true };",
  };
  const problems = checkReferences(collectReferences(next), hashIn(next), manifest);
  assert.ok(problems.some((p) => p.startsWith("js/palette-ui.js: changed without a ?v= bump")));
  assert.ok(problems.some((p) => p.startsWith("js/app.js: changed without a ?v= bump")));
});

test("a recorded tree passes, and mixed versions are reported", () => {
  assert.deepEqual(checkReferences(collectReferences(v1), hashIn(v1), record(v1)), []);
  const mixed = { ...v1, "js/palette-ui.js": 'import "./context.js?v=2";' };
  const problems = checkReferences(collectReferences(mixed), hashIn(mixed), record(v1));
  assert.ok(problems.some((p) => p.includes("js/context.js: referenced with different versions")));
});

test("fixReferences cascades a bump up to index.html and records the result", () => {
  const manifest = record(v1);
  const edited = { ...v1, "js/context.js": "export const state = { changed: true };" };
  const { sources, manifest: next, bumped } = fixReferences(edited, noDisk, manifest);
  assert.deepEqual(bumped, ["js/app.js", "js/context.js", "js/palette-ui.js"]);
  assert.equal(sources["js/palette-ui.js"], 'import "./context.js?v=2";');
  assert.equal(sources["js/app.js"], 'import "./palette-ui.js?v=2";\nimport "./context.js?v=2";');
  assert.equal(sources["index.html"], '<script src="js/app.js?v=2"></script>');
  assert.deepEqual(checkReferences(collectReferences(sources), hashIn(sources), next), []);
});

test("fixReferences leaves an unchanged tree alone", () => {
  const { sources, bumped } = fixReferences(v1, noDisk, record(v1));
  assert.deepEqual(bumped, []);
  assert.deepEqual(sources, v1);
});
