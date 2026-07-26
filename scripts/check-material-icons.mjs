import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const icons = [
  "architecture",
  "brush",
  "colorize",
  "content_copy",
  "folder_open",
  "image",
  "invert_colors",
  "picture_as_pdf",
  "redo",
  "restore",
  "rotate_left",
  "rotate_right",
  "save",
  "undo",
  "upload_file",
];

for (const name of icons) {
  const [checkedIn, upstream] = await Promise.all([
    readFile(new URL(`../assets/icons/material/${name}.svg`, import.meta.url), "utf8"),
    readFile(
      new URL(`../node_modules/@material-design-icons/svg/outlined/${name}.svg`, import.meta.url),
      "utf8",
    ),
  ]);
  assert.equal(
    checkedIn.trimEnd(),
    upstream.trimEnd(),
    `${name}.svg differs from @material-design-icons/svg`,
  );
}

console.log(`${icons.length} checked-in Material icons match the pinned package.`);
