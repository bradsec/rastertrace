import { readFile } from "node:fs/promises";

/**
 * Import the exact `context.js?v=N` specifier that `moduleName` imports.
 *
 * Node keys its module cache on the full specifier, query string included,
 * so a test that hardcodes the version gets a second, unused copy of the
 * shared `state` object the moment someone bumps the cache buster. The
 * assertions then fail on empty output instead of on anything real. Reading
 * the specifier out of the source keeps the two in step automatically.
 *
 * @param {string} moduleName file name under js/, e.g. "exporters.js"
 * @returns {Promise<{ state: Record<string, any>, els: Record<string, any> }>}
 */
export async function sharedContext(moduleName) {
  const source = await readFile(new URL(`../js/${moduleName}`, import.meta.url), "utf8");
  const specifier = source.match(/["'](\.\/context\.js(?:\?v=\d+)?)["']/)?.[1];
  if (!specifier) {
    throw new Error(`${moduleName} does not import context.js; update sharedContext()`);
  }
  return import(`../js/${specifier.slice(2)}`);
}
