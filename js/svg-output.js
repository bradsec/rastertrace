// SVG string post-processing: export options, path compression,
// straightening, fill grouping and final markup.
// Pure functions: they run in Node (tests) and the browser (worker/app).

/**
 * @param {unknown} value
 */
function stripInvalidXmlCharacters(value) {
  let result = "";
  for (const character of String(value)) {
    const codePoint = /** @type {number} */ (character.codePointAt(0));
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      result += character;
    }
  }
  return result;
}

/**
 * Post-process a finalized SVG for export. Options:
 * - minify: drop the XML declaration and generator comment, and compress
 *   path data (relative commands, baked translates).
 * - physicalWidth + physicalUnit ("px"|"mm"|"cm"|"in"): rewrite the root
 *   width/height to the requested unit, height from the pixel aspect ratio,
 *   keeping the viewBox so the file still scales.
 * - title: insert an escaped <title> as the first child and role="img".
 *
 * @param {string} svgText
 * @param {{ physicalWidth?: number, physicalUnit?: string, title?: string, minify?: boolean }} [options]
 */
export function applyExportOptions(svgText, { physicalWidth, physicalUnit, title, minify } = {}) {
  let out = svgText;
  if (minify) {
    out = compressSvgPaths(out.replace(/^<\?xml[^?]*\?>\s*/, "").replace(/^<!--.*?-->\s*/s, ""));
  }
  if (physicalWidth && physicalWidth > 0 && physicalUnit) {
    out = out.replace(
      /(<svg[^>]*?) width="(\d+)" height="(\d+)"( viewBox="[^"]*")/,
      (_, head, w, h, vb) => {
        const height = Number((physicalWidth * (h / w)).toFixed(2));
        return `${head} width="${physicalWidth}${physicalUnit}" height="${height}${physicalUnit}"${vb}`;
      },
    );
  }
  if (title) {
    const escaped = stripInvalidXmlCharacters(title)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    out = out.replace(
      /(<svg[^>]*)>/,
      (_, head) => `${head} role="img">\n<title>${escaped}</title>`,
    );
  }
  return out;
}

// Compact decimal for compressed path data: at most 4 places, trailing
// zeros trimmed, "0.5" as ".5", "-0" as "0".
/**
 * @param {number} n
 */
function compactNum(n) {
  let s = n
    .toFixed(4)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s.replace(/^(-?)0\./, "$1.");
}

/**
 * Shrink traced SVG path data for export: bakes each path's
 * translate() into its coordinates, converts absolute M/L/C/Z commands
 * to relative ones with h/v/s shorthands and implicit repetition, and
 * trims number formatting. Paths with any other command or transform are
 * left untouched. The output is for the SVG download only; it no longer
 * matches the absolute shape parseSvgPaths expects.
 * @param {string} svgText
 */
export function compressSvgPaths(svgText) {
  return svgText.replace(/<path\b[^>]*\/>/g, (path) => {
    const d = path.match(/\sd="([^"]*)"/)?.[1];
    if (!d) return path;
    const tr = path.match(/\stransform="([^"]*)"/)?.[1];
    let dx = 0;
    let dy = 0;
    if (tr) {
      const m = tr.match(/^translate\((-?[\d.]+)[, ](-?[\d.]+)\)$/);
      if (!m) return path;
      dx = Number(m[1]);
      dy = Number(m[2]);
    }
    const compressed = compressPathData(d, dx, dy);
    if (compressed === null) return path;
    return path
      .replace(/(\sd=")[^"]*(")/, (_, head, tail) => head + compressed + tail)
      .replace(/\s+transform="[^"]*"/, "");
  });
}

/**
 * @param {string} d
 * @param {number} dx
 * @param {number} dy
 */
function compressPathData(d, dx, dy) {
  const tokens = d.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z]/g) || [];
  let out = "";
  let lastNum = "";
  let lastCmd = "";
  // Position a renderer of the emitted data has reached: deltas are
  // computed against it so rounding never accumulates into drift.
  let ex = 0;
  let ey = 0;
  let startX = 0;
  let startY = 0;
  /** @type {{ x: number, y: number } | null} absolute second control point of a preceding c/s */
  let prevC2 = null;
  let i = 0;
  const read = () => Number(tokens[i++]);

  /**
   * @param {string} letter
   */
  const cmd = (letter) => {
    if (letter === lastCmd && (letter === "l" || letter === "c" || letter === "s")) return;
    out += letter;
    lastCmd = letter;
    lastNum = "";
  };
  /**
   * @param {number} n
   */
  const num = (n) => {
    const s = compactNum(n);
    if (lastNum && !s.startsWith("-") && !(s.startsWith(".") && lastNum.includes("."))) {
      out += " ";
    }
    out += s;
    lastNum = s;
  };

  /** @type {string | null} */
  let op = null;
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) {
      op = tokens[i++];
      if (op === "Z" || op === "z") {
        cmd("z");
        ex = startX;
        ey = startY;
        prevC2 = null;
        op = null;
        continue;
      }
    }
    switch (op) {
      case "M": {
        const x = read() + dx;
        const y = read() + dy;
        if (out === "") {
          out = "M";
          lastCmd = "M";
          lastNum = "";
          num(x);
          num(y);
        } else {
          cmd("m");
          lastCmd = ""; // pairs after m are implicit lineto, not m
          num(x - ex);
          num(y - ey);
          lastCmd = "l";
        }
        ex = x;
        ey = y;
        startX = x;
        startY = y;
        prevC2 = null;
        op = "L";
        break;
      }
      case "L": {
        const x = read() + dx;
        const y = read() + dy;
        const rx = Number(compactNum(x - ex));
        const ry = Number(compactNum(y - ey));
        if (ry === 0 && rx !== 0) {
          cmd("h");
          num(rx);
        } else if (rx === 0 && ry !== 0) {
          cmd("v");
          num(ry);
        } else {
          cmd("l");
          num(rx);
          num(ry);
        }
        ex += rx;
        ey += ry;
        prevC2 = null;
        break;
      }
      case "C": {
        const c1x = read() + dx;
        const c1y = read() + dy;
        const c2x = read() + dx;
        const c2y = read() + dy;
        const x = read() + dx;
        const y = read() + dy;
        /**
         * @type {boolean | null}
         */
        const smooth =
          prevC2 &&
          Math.abs(2 * ex - prevC2.x - c1x) < 5e-5 &&
          Math.abs(2 * ey - prevC2.y - c1y) < 5e-5;
        /**
         * @type {number[]}
         */
        const coords = smooth ? [c2x, c2y, x, y] : [c1x, c1y, c2x, c2y, x, y];
        cmd(smooth ? "s" : "c");
        const emitted = [];
        for (let k = 0; k < coords.length; k += 2) {
          /**
           * @type {number}
           */
          const rx = Number(compactNum(coords[k] - ex));
          const ry = Number(compactNum(coords[k + 1] - ey));
          num(rx);
          num(ry);
          emitted.push([rx, ry]);
        }
        const [lx, ly] = emitted[emitted.length - 1];
        prevC2 = { x: ex + emitted[emitted.length - 2][0], y: ey + emitted[emitted.length - 2][1] };
        ex += lx;
        ey += ly;
        break;
      }
      default:
        return null; // unexpected command: leave the path untouched
    }
  }
  return out;
}

/**
 * Recolor a binary stencil trace for white-ink output: the shapes turn
 * white on transparency, one ink like the black stencil, so nothing extra
 * prints or cuts. Binary stencil traces have exactly one fill value in
 * the whole document, so a blanket replace is safe. No-op for "black".
 * @param {string} svgText
 * @param {string} ink
 */
export function applyStencilInk(svgText, ink) {
  if (ink !== "white") return svgText;
  return svgText.replace(/fill="#000000"/g, 'fill="#ffffff"');
}

/**
 * Wrap runs of adjacent same-fill <path> elements in a shared
 * <g fill="..."> and drop the per-path fill attributes. Only paths
 * separated by whitespace count as adjacent, and only adjacent runs
 * merge: stacked output relies on document order for z-order, so
 * non-adjacent same-fill paths must stay where they are.
 * @param {string} svgText
 */
export function groupSvgFills(svgText) {
  /**
   * @param {string} path
   */
  const fillOf = (path) => (path.match(/\sfill="([^"]*)"/) || [])[1] || null;
  const matches = [...svgText.matchAll(/<path\b[^>]*\/>/g)];
  let out = "";
  let cursor = 0;
  let i = 0;
  while (i < matches.length) {
    const fill = fillOf(matches[i][0]);
    let j = i;
    if (fill) {
      while (
        j + 1 < matches.length &&
        fillOf(matches[j + 1][0]) === fill &&
        /^\s*$/.test(svgText.slice(matches[j].index + matches[j][0].length, matches[j + 1].index))
      ) {
        j++;
      }
    }
    if (j > i) {
      out += svgText.slice(cursor, matches[i].index) + `<g fill="${fill}">\n`;
      for (let k = i; k <= j; k++) {
        out += matches[k][0].replace(/\s+fill="[^"]*"/, "");
        out +=
          k < j
            ? svgText.slice(matches[k].index + matches[k][0].length, matches[k + 1].index)
            : "\n";
      }
      out += "</g>";
      cursor = matches[j].index + matches[j][0].length;
    }
    i = j + 1;
  }
  return out + svgText.slice(cursor);
}

/**
 * Regroup same-fill paths after palette edits and name each group
 * id="color-rrggbb" so design tools list layers by color. Stacked output
 * keeps document order (z-order), so a color drawn in several runs gets
 * numbered ids (color-ffffff-2). Mosaic (cutout) shapes never overlap,
 * which makes reordering safe: each color collects into one group, in
 * order of first appearance. Hidden ("none") and non-hex fills stay
 * unnamed.
 * @param {string} svgText
 * @param {{ mosaic?: boolean }} [options]
 */
export function nameColorGroups(svgText, { mosaic = false } = {}) {
  // finalizeSvg groups never nest, so each <g fill> closes at the next </g>.
  let out = svgText.replace(/<g fill="([^"]*)">([\s\S]*?)<\/g>/g, (_, fill, inner) =>
    inner.replace(/<path\b/g, `<path fill="${fill}"`).trim(),
  );
  if (mosaic) {
    const paths = [...out.matchAll(/<path\b[^>]*\/>/g)];
    const contiguous = paths.every(
      (m, i) =>
        i === 0 || /^\s*$/.test(out.slice(paths[i - 1].index + paths[i - 1][0].length, m.index)),
    );
    if (paths.length > 1 && contiguous) {
      /** @type {Map<string, string[]>} */
      const byFill = new Map();
      for (const [path] of paths) {
        const fill = path.match(/\sfill="([^"]*)"/)?.[1] ?? "";
        const group = byFill.get(fill);
        if (group) group.push(path);
        else byFill.set(fill, [path]);
      }
      const first = paths[0];
      const last = /** @type {RegExpExecArray} */ (paths.at(-1)); // paths.length > 1
      out =
        out.slice(0, first.index) +
        [...byFill.values()].flat().join("\n") +
        out.slice(last.index + last[0].length);
    }
  }
  /** @type {Map<string, number>} */
  const seen = new Map();
  const idFor = (/** @type {string} */ fill) => {
    const hex = fill.match(/^#([0-9a-f]{6})$/i)?.[1]?.toLowerCase();
    if (!hex) return null;
    const n = (seen.get(hex) ?? 0) + 1;
    seen.set(hex, n);
    return n === 1 ? `color-${hex}` : `color-${hex}-${n}`;
  };
  // After grouping, only group tags and lone paths carry a fill.
  return groupSvgFills(out).replace(
    /<g fill="([^"]*)">|<path\b(?=[^>]*\sfill="([^"]*)")/g,
    (tag, groupFill, pathFill) => {
      const id = idFor(groupFill ?? pathFill);
      if (!id) return tag;
      return groupFill === undefined ? `<path id="${id}"` : `<g fill="${groupFill}" id="${id}">`;
    },
  );
}

/**
 * Perpendicular distance from point p to the line through a and b.
 * @param {{ x: number, y: number }} p
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 */
function distanceToChord(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len = Math.hypot(vx, vy);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * vy - (p.y - a.y) * vx) / len;
}

/**
 * @param {number} n
 */
const num = (n) => String(Number(n));

/**
 * Straighten traced path data: cubics whose control points sit within
 * `tolerance` of their chord become lines, and runs of consecutive lines
 * whose interior points sit within `tolerance` of the run's chord merge
 * into one line. Corners survive because merging stops as soon as a
 * point leaves the tolerance band. Output keeps the tracer's absolute
 * M/L/C/Z shape, so parseSvgPaths and the eraser keep working.
 * @param {string} svgText
 * @param {number} tolerance
 */
export function straightenPaths(svgText, tolerance) {
  if (!(tolerance > 0)) return svgText;
  return svgText.replace(/(<path\b[^>]*?\sd=")([^"]*)(")/g, (_, head, d, tail) => {
    return head + straightenPathData(d, tolerance) + tail;
  });
}

/**
 * @param {string} d
 * @param {number} tolerance
 */
function straightenPathData(d, tolerance) {
  const tokens = d.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z]/g) || [];
  let out = "";
  let i = 0;
  /** @type {string | null} */
  let cmd = null;
  let point = { x: 0, y: 0 };
  // Lines buffered for merging: linePoints[0] is the run's anchor.
  /**
   * @type {{ x: number, y: number }[]}
   */
  let linePoints = [];
  const read = () => Number(tokens[i++]);

  const flushLines = () => {
    while (linePoints.length > 1) {
      const anchor = linePoints[0];
      // Longest prefix whose interior points all fit the tolerance band.
      let end = 1;
      for (let j = 2; j < linePoints.length; j++) {
        let fits = true;
        for (let k = 1; k < j && fits; k++) {
          fits = distanceToChord(linePoints[k], anchor, linePoints[j]) <= tolerance;
        }
        if (fits) end = j;
        else break;
      }
      out += `L${num(linePoints[end].x)} ${num(linePoints[end].y)} `;
      linePoints = linePoints.slice(end);
    }
    linePoints = [];
  };

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === "Z" || cmd === "z") {
        flushLines();
        out += "Z ";
        cmd = null;
        continue;
      }
    }
    switch (cmd) {
      case "M": {
        flushLines();
        point = { x: read(), y: read() };
        out += `M${num(point.x)} ${num(point.y)} `;
        cmd = "L"; // extra pairs after M are implicit lines
        break;
      }
      case "L": {
        const to = { x: read(), y: read() };
        if (!linePoints.length) linePoints.push(point);
        linePoints.push(to);
        point = to;
        break;
      }
      case "C": {
        const c1 = { x: read(), y: read() };
        const c2 = { x: read(), y: read() };
        const to = { x: read(), y: read() };
        const straight =
          distanceToChord(c1, point, to) <= tolerance &&
          distanceToChord(c2, point, to) <= tolerance;
        if (straight) {
          if (!linePoints.length) linePoints.push(point);
          linePoints.push(to);
        } else {
          flushLines();
          out += `C${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(to.x)} ${num(to.y)} `;
        }
        point = to;
        break;
      }
      default:
        return d; // unexpected command: leave the path untouched
    }
  }
  flushLines();
  return out;
}

/**
 * Rewrite the SVG root so the document keeps the source pixel dimensions
 * with a viewBox, hiding the internal upscale factor, and group same-fill
 * paths to shrink the file. Returns the root unchanged when it does not
 * match the expected vtracer shape.
 * @param {string} svgText
 * @param {number} width
 * @param {number} height
 */
export function finalizeSvg(svgText, width, height) {
  return groupSvgFills(svgText).replace(
    /(<svg[^>]*?) width="(\d+)" height="(\d+)">/,
    (_, head, w, h) =>
      `${head} width="${width}" height="${height}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`,
  );
}

/**
 * True when a worker/module failure message indicates a stale or
 * mismatched cached module (deploy caught mid-propagation, service
 * worker pinned the bad copy) rather than a tracing error.
 * @param {string} message
 */
export function isStaleModuleError(message) {
  return /importing binding|does not provide an export|SyntaxError|import.* module/i.test(
    String(message || ""),
  );
}

/**
 * Count path elements in an SVG string.
 * @param {string} svgText
 */
export function countPaths(svgText) {
  return (svgText.match(/<path\b/g) || []).length;
}
