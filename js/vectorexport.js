// DXF and PDF writers for traced output. Pure string work, Node-testable.
// The input is our own finalized SVG, which keeps a very regular shape:
// uppercase absolute M/L/C/Z path data, per-path fill and translate().

/**
 * @typedef {{ x: number, y: number }} VecPoint
 * @typedef {{ kind: "line", to: VecPoint } | { kind: "cubic", c1: VecPoint, c2: VecPoint, to: VecPoint }} VecSegment
 * @typedef {{ start: VecPoint, segments: VecSegment[], closed: boolean }} VecSubpath
 * @typedef {{ fill: string, subpaths: VecSubpath[] }} VecPath
 * @typedef {{ width: number, height: number, paths: VecPath[] }} ParsedSvg
 */

/** Trim a number to a compact decimal string (max 4 places). */
function fmt(n) {
  return String(Number(n.toFixed(4)));
}

/**
 * Parse the traced SVG into { width, height, paths } where each path is
 * { fill, subpaths: [{ start, segments, closed }] } and each segment is
 * { kind: "line", to } or { kind: "cubic", c1, c2, to }. Coordinates are
 * in viewBox space with the per-path translate applied.
 *
 * @param {string} svgText
 * @returns {ParsedSvg}
 */
export function parseSvgPaths(svgText) {
  const vb = svgText.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const wh = svgText.match(/<svg[^>]*? width="([\d.]+)"[^>]*? height="([\d.]+)"/);
  const width = Number(vb ? vb[1] : (wh?.[1] ?? 0));
  const height = Number(vb ? vb[2] : (wh?.[2] ?? 0));

  // Walk groups and paths in document order: finalizeSvg moves the fill
  // of grouped same-fill paths onto the enclosing <g>, so a path without
  // its own fill inherits the innermost group's.
  const paths = [];
  const groupFills = [];
  for (const el of svgText.matchAll(/<g\b[^>]*>|<\/g>|<path\b[^>]*>/g)) {
    const tag = el[0];
    if (tag.startsWith("<g")) {
      groupFills.push(tag.match(/\sfill="([^"]*)"/)?.[1] ?? groupFills.at(-1));
      continue;
    }
    if (tag.startsWith("</g")) {
      groupFills.pop();
      continue;
    }
    const d = tag.match(/\sd="([^"]*)"/)?.[1];
    if (!d) continue;
    const fill = tag.match(/\sfill="([^"]*)"/)?.[1] ?? groupFills.at(-1) ?? "#000000";
    const tr = tag.match(/translate\((-?[\d.]+)[, ](-?[\d.]+)\)/);
    const dx = tr ? Number(tr[1]) : 0;
    const dy = tr ? Number(tr[2]) : 0;
    paths.push({ fill, subpaths: parsePathData(d, dx, dy) });
  }
  return { width, height, paths };
}

function parsePathData(d, dx, dy) {
  const tokens = d.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z]/g) || [];
  const subpaths = [];
  let current = null;
  let cmd = null;
  let point = { x: 0, y: 0 };
  let i = 0;
  const read = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === "Z" || cmd === "z") {
        if (current) {
          current.closed = true;
          point = current.start;
        }
        continue;
      }
    }
    switch (cmd) {
      case "M": {
        point = { x: read() + dx, y: read() + dy };
        current = { start: point, segments: [], closed: false };
        subpaths.push(current);
        cmd = "L"; // extra coordinate pairs after M are implicit lines
        break;
      }
      case "L": {
        point = { x: read() + dx, y: read() + dy };
        current.segments.push({ kind: "line", to: point });
        break;
      }
      case "C": {
        const c1 = { x: read() + dx, y: read() + dy };
        const c2 = { x: read() + dx, y: read() + dy };
        point = { x: read() + dx, y: read() + dy };
        current.segments.push({ kind: "cubic", c1, c2, to: point });
        break;
      }
      default:
        throw new Error(`Unsupported path command: ${cmd}`);
    }
  }
  return subpaths;
}

/**
 * Flatten a cubic Bezier into line-segment end points (excluding p0,
 * including p1), subdividing until the control points sit within `tol`
 * of the chord.
 */
export function flattenCubic(p0, c1, c2, p1, tol, depth = 0) {
  const flatEnough = (p) => {
    const vx = p1.x - p0.x;
    const vy = p1.y - p0.y;
    const len = Math.hypot(vx, vy);
    if (len < 1e-9) return Math.hypot(p.x - p0.x, p.y - p0.y) <= tol;
    return Math.abs((p.x - p0.x) * vy - (p.y - p0.y) * vx) / len <= tol;
  };
  if (depth >= 16 || (flatEnough(c1) && flatEnough(c2))) return [p1];
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = mid(p0, c1);
  const p12 = mid(c1, c2);
  const p23 = mid(c2, p1);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);
  return [
    ...flattenCubic(p0, p01, p012, p0123, tol, depth + 1),
    ...flattenCubic(p0123, p123, p23, p1, tol, depth + 1),
  ];
}

/** Nearest AutoCAD color index for a hex fill (basic ACI palette). */
function aciColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  /** @type {[number, number[]][]} */
  const palette = [
    [1, [255, 0, 0]],
    [2, [255, 255, 0]],
    [3, [0, 255, 0]],
    [4, [0, 255, 255]],
    [5, [0, 0, 255]],
    [6, [255, 0, 255]],
    [7, [255, 255, 255]],
    [7, [0, 0, 0]], // ACI 7 renders as black-or-white depending on background
    [8, [128, 128, 128]],
  ];
  let best = 7;
  let bestDist = Infinity;
  for (const [aci, c] of palette) {
    const dist = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = aci;
    }
  }
  return best;
}

// Curve flattening tolerance in viewBox pixels: 0.2 px of a >=2048 px
// trace is far below any cutter's mechanical resolution.
const FLATTEN_TOL = 0.2;

/**
 * Write a minimal DXF R12 document: one closed POLYLINE per subpath,
 * one layer per fill color, y axis flipped to DXF's y-up convention.
 * `scale` converts viewBox pixels to output units (e.g. mm).
 *
 * @param {ParsedSvg} parsed
 * @param {{ scale?: number }} [options]
 */
export function toDxf(parsed, { scale = 1 } = {}) {
  const { height, paths } = parsed;
  const g = (code, value) => `${code}\n${value}\n`;
  const layers = new Map();
  for (const path of paths) {
    layers.set(`C_${path.fill.replace("#", "")}`, aciColor(path.fill));
  }

  let out = "";
  out += g(0, "SECTION") + g(2, "HEADER") + g(9, "$ACADVER") + g(1, "AC1009") + g(0, "ENDSEC");
  out += g(0, "SECTION") + g(2, "TABLES") + g(0, "TABLE") + g(2, "LAYER") + g(70, layers.size);
  for (const [name, aci] of layers) {
    out += g(0, "LAYER") + g(2, name) + g(70, 0) + g(62, aci) + g(6, "CONTINUOUS");
  }
  out += g(0, "ENDTAB") + g(0, "ENDSEC");
  out += g(0, "SECTION") + g(2, "ENTITIES");

  for (const path of paths) {
    const layer = `C_${path.fill.replace("#", "")}`;
    for (const sub of path.subpaths) {
      let points = [sub.start];
      let prev = sub.start;
      for (const seg of sub.segments) {
        if (seg.kind === "line") points.push(seg.to);
        else points.push(...flattenCubic(prev, seg.c1, seg.c2, seg.to, FLATTEN_TOL));
        prev = seg.to;
      }
      // A closed polyline does not need an end point equal to the start.
      const last = points[points.length - 1];
      if (sub.closed && points.length > 1 && last.x === sub.start.x && last.y === sub.start.y) {
        points = points.slice(0, -1);
      }
      out += g(0, "POLYLINE") + g(8, layer) + g(66, 1) + g(70, sub.closed ? 1 : 0);
      for (const p of points) {
        out +=
          g(0, "VERTEX") +
          g(8, layer) +
          g(10, fmt(p.x * scale)) +
          g(20, fmt((height - p.y) * scale)) +
          g(30, 0);
      }
      out += g(0, "SEQEND");
    }
  }
  out += g(0, "ENDSEC") + g(0, "EOF");
  return out;
}

/**
 * Write a single-page vector PDF. Curves stay curves (SVG cubics map to
 * the PDF `c` operator 1:1); holes survive through nonzero fill. Page
 * size in points; defaults to the pixel dimensions at 96 dpi.
 *
 * @param {ParsedSvg} parsed
 * @param {{ pageWidth?: number, pageHeight?: number }} [options]
 */
export function toPdf(parsed, { pageWidth, pageHeight } = {}) {
  const { width, height, paths } = parsed;
  const pw = pageWidth ?? (width * 72) / 96;
  const ph = pageHeight ?? (height * 72) / 96;

  // One transform maps SVG space (y down) onto the page (y up).
  let content = `${fmt(pw / width)} 0 0 ${fmt(-ph / height)} 0 ${fmt(ph)} cm\n`;
  for (const path of paths) {
    const n = parseInt(path.fill.slice(1), 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => fmt(v / 255));
    content += `${rgb.join(" ")} rg\n`;
    for (const sub of path.subpaths) {
      content += `${fmt(sub.start.x)} ${fmt(sub.start.y)} m\n`;
      for (const seg of sub.segments) {
        if (seg.kind === "line") {
          content += `${fmt(seg.to.x)} ${fmt(seg.to.y)} l\n`;
        } else {
          content += `${fmt(seg.c1.x)} ${fmt(seg.c1.y)} ${fmt(seg.c2.x)} ${fmt(seg.c2.y)} ${fmt(seg.to.x)} ${fmt(seg.to.y)} c\n`;
        }
      }
      if (sub.closed) content += "h\n";
    }
    content += " f\n";
  }

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pw)} ${fmt(ph)}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}
