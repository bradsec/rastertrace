import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const icons = await readdir(new URL("assets/icons/lucide/", root));
const sources = ["index.html"];
for (const dir of ["js", "css"]) {
  for (const file of await readdir(new URL(`${dir}/`, root))) {
    if (file.endsWith(dir === "js" ? ".js" : ".css")) sources.push(`${dir}/${file}`);
  }
}

const references = new Set();
const classes = new Set();
for (const source of sources) {
  const content = await readFile(new URL(source, root), "utf8");
  for (const match of content.matchAll(/\bicon icon-([a-z0-9-]+)/g)) {
    references.add(match[1]);
    classes.add(match[1]);
  }
  for (const match of content.matchAll(/assets\/icons\/lucide\/([a-z0-9-]+)\.svg/g)) {
    references.add(match[1]);
  }
}

assert.ok(icons.length, "No Lucide icons are bundled");
for (const name of references) {
  assert.ok(icons.includes(`${name}.svg`), `Missing Lucide icon: ${name}.svg`);
}
const css = await readFile(new URL("css/tool-rail.css", root), "utf8");
for (const name of classes) {
  assert.ok(css.includes(`.icon-${name} {`), `Missing CSS mask for ${name}`);
}
for (const file of icons) {
  assert.match(file, /^[a-z0-9-]+\.svg$/);
  const [checkedIn, upstream] = await Promise.all([
    readFile(new URL(`assets/icons/lucide/${file}`, root)),
    readFile(new URL(`node_modules/lucide-static/icons/${file}`, root)),
  ]);
  assert.deepEqual(checkedIn, upstream, `${file} differs from lucide-static`);
}

console.log(`${icons.length} bundled Lucide icons match lucide-static; all references exist.`);
