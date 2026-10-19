// Cache busters: every ?v= asset URL must change whenever the file it
// names changes. sw.js serves ?v= assets cache-first, so a file edited
// under an old version keeps running stale for returning visitors, and a
// stale module that imports an older context.js gets its own, empty
// state. Changing a version edits the importing file too, which then
// needs its own bump, up to index.html. A manifest of recorded versions
// and content hashes makes a missed bump detectable.
import { createHash } from "node:crypto";
import path from "node:path";

const REFERENCE = /([\w./-]+\.(?:js|css|wasm|svg|png|ico|json|webmanifest))\?v=(\d+)/g;

/** sha256 of a file's bytes or text, hex. */
export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Every ?v= reference in `sources` ({ path: text }), with the target
 * resolved relative to the referencing file, in POSIX form.
 * @param {Record<string, string>} sources
 * @returns {{ from: string, target: string, version: number }[]}
 */
export function collectReferences(sources) {
  const refs = [];
  for (const [from, text] of Object.entries(sources)) {
    for (const [, url, version] of text.matchAll(REFERENCE)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), url));
      refs.push({ from, target, version: Number(version) });
    }
  }
  return refs;
}

/** Target to its distinct referenced versions. */
function versionsByTarget(refs) {
  /** @type {Map<string, Set<number>>} */
  const versions = new Map();
  for (const { target, version } of refs) {
    if (!versions.has(target)) versions.set(target, new Set());
    versions.get(target).add(version);
  }
  return versions;
}

/**
 * Problems with the current references against the recorded manifest
 * ({ target: { v, sha } }). `hashOf(target)` returns the target's hash.
 * @returns {string[]}
 */
export function checkReferences(refs, hashOf, manifest) {
  const problems = [];
  const versions = versionsByTarget(refs);
  for (const [target, set] of versions) {
    if (set.size > 1) {
      problems.push(`${target}: referenced with different versions (${[...set].join(", ")})`);
      continue;
    }
    const [v] = set;
    const entry = manifest[target];
    const sha = hashOf(target);
    if (!entry) problems.push(`${target}: not recorded in the manifest`);
    else if (entry.v === v && entry.sha !== sha) {
      problems.push(`${target}: changed without a ?v= bump (still v=${v})`);
    } else if (entry.v !== v || entry.sha !== sha) {
      problems.push(`${target}: manifest out of date (v=${v})`);
    }
  }
  for (const target of Object.keys(manifest)) {
    if (!versions.has(target)) problems.push(`${target}: in the manifest but no longer referenced`);
  }
  return problems;
}

/**
 * Bump every target that changed under its recorded version, or is
 * referenced with mixed versions, rewriting its references in `sources`.
 * Rewrites change the referencing files, so repeat until nothing else
 * changes. Returns the rewritten sources, the new manifest, and the
 * bumped targets. `readTarget(target)` returns bytes for targets that are
 * not in `sources`.
 */
export function fixReferences(sources, readTarget, manifest) {
  /** @type {Record<string, string>} */
  const out = { ...sources };
  const hashOf = (target) => hashContent(target in out ? out[target] : readTarget(target));
  const bumped = new Set();
  for (;;) {
    const versions = versionsByTarget(collectReferences(out));
    const stale = [...versions].filter(([target, set]) => {
      const entry = manifest[target];
      return set.size > 1 || (entry && set.has(entry.v) && entry.sha !== hashOf(target));
    });
    if (!stale.length) break;
    for (const [target, set] of stale) {
      const next = Math.max(...set, manifest[target]?.v ?? 0) + 1;
      for (const [from, text] of Object.entries(out)) {
        out[from] = text.replace(REFERENCE, (match, url, _v) => {
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), url));
          return resolved === target ? `${url}?v=${next}` : match;
        });
      }
      // Now off its recorded version, so later passes leave it alone even
      // when a cascaded rewrite changes it again.
      bumped.add(target);
    }
  }
  const recorded = {};
  for (const [target, set] of [...versionsByTarget(collectReferences(out))].sort()) {
    recorded[target] = { v: Math.max(...set), sha: hashOf(target) };
  }
  return { sources: out, manifest: recorded, bumped: [...bumped].sort() };
}
