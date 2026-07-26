const MASK_ID = "rastertrace-eraser-mask";
const CLEANUP_MASK_ID = "rastertrace-cleanup-mask";

export function svgViewBox(svg) {
  const match = svg.match(
    /\bviewBox\s*=\s*["']\s*([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)\s*["']/i,
  );
  if (!match) return null;
  const values = match.slice(1).map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return null;
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

export function snapPointToAngle(anchor, point, width, height, increment = Math.PI / 4) {
  if (!(width > 0) || !(height > 0) || !(increment > 0)) return point;
  const dx = (point.x - anchor.x) * width;
  const dy = (point.y - anchor.y) * height;
  const distance = Math.hypot(dx, dy);
  if (!distance) return point;
  const angle = Math.round(Math.atan2(dy, dx) / increment) * increment;
  return {
    x: anchor.x + (Math.cos(angle) * distance) / width,
    y: anchor.y + (Math.sin(angle) * distance) / height,
  };
}

function n(value) {
  return Number(value.toFixed(3));
}

function pointInBox(point, box) {
  return {
    x: box.x + point.x * box.width,
    y: box.y + point.y * box.height,
  };
}

function pixelCenter(value, origin) {
  return origin + Math.floor(value - origin) + 0.5;
}

function pixelExactStrokeMarkup(erasure, box) {
  const points = erasure.points.map((point) => {
    const absolute = pointInBox(point, box);
    return {
      x: pixelCenter(absolute.x, box.x),
      y: pixelCenter(absolute.y, box.y),
    };
  });
  // An odd number of trace pixels keeps a centreline on pixel centres and
  // both outside edges on pixel boundaries.
  const requested = Math.max(1, erasure.diameter * Math.min(box.width, box.height));
  const diameter = Math.max(1, 2 * Math.round((requested - 1) / 2) + 1);
  if (points.length === 1) {
    return `<rect x="${n(points[0].x - diameter / 2)}" y="${n(points[0].y - diameter / 2)}" width="${diameter}" height="${diameter}" fill="#000" shape-rendering="crispEdges"/>`;
  }

  // Route between snapped pixel centres using axis-aligned segments. The
  // square, mitered stroke therefore exposes only trace-pixel boundaries.
  let d = `M${n(points[0].x)} ${n(points[0].y)}`;
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    d += `H${n(point.x)}V${n(point.y)}`;
  }
  return `<path d="${d}" fill="none" stroke="#000" stroke-width="${diameter}" stroke-linecap="square" stroke-linejoin="miter" shape-rendering="crispEdges"/>`;
}

function erasureMarkup(erasure, box, pixelExact) {
  if (erasure.type === "rect") {
    return `<rect x="${n(box.x + erasure.x * box.width)}" y="${n(box.y + erasure.y * box.height)}" width="${n(erasure.width * box.width)}" height="${n(erasure.height * box.height)}" fill="#000"/>`;
  }
  if (erasure.type === "ellipse") {
    return `<ellipse cx="${n(box.x + erasure.cx * box.width)}" cy="${n(box.y + erasure.cy * box.height)}" rx="${n(erasure.rx * box.width)}" ry="${n(erasure.ry * box.height)}" fill="#000"/>`;
  }
  if (erasure.type === "polygon") {
    const points = erasure.points.map((point) => pointInBox(point, box));
    return `<polygon points="${points.map((point) => `${n(point.x)},${n(point.y)}`).join(" ")}" fill="#000"/>`;
  }
  if (pixelExact) return pixelExactStrokeMarkup(erasure, box);

  const points = erasure.points.map((point) => pointInBox(point, box));
  const diameter = Math.max(0.01, erasure.diameter * Math.min(box.width, box.height));
  if (points.length === 1) {
    return `<circle cx="${n(points[0].x)}" cy="${n(points[0].y)}" r="${n(diameter / 2)}" fill="#000"/>`;
  }
  const d = points
    .map((point, index) => `${index ? "L" : "M"}${n(point.x)} ${n(point.y)}`)
    .join(" ");
  return `<path d="${d}" fill="none" stroke="#000" stroke-width="${n(diameter)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function fillMarkup(stroke, box, pixelExact) {
  const mark = erasureMarkup(stroke, box, pixelExact);
  return mark
    .replace(/fill="#000"/g, `fill="${stroke.color}"`)
    .replace(/stroke="#000"/g, `stroke="${stroke.color}"`);
}

function svgParts(svg) {
  const rootStart = svg.search(/<svg\b/i);
  const openEnd = rootStart < 0 ? -1 : svg.indexOf(">", rootStart);
  const closeStart = svg.lastIndexOf("</svg>");
  if (openEnd < 0 || closeStart < openEnd) return null;
  return {
    before: svg.slice(0, openEnd + 1),
    content: svg.slice(openEnd + 1, closeStart),
    after: svg.slice(closeStart),
  };
}

export function applyEraserMask(svg, strokes, { pixelExact = false } = {}) {
  if (!strokes.length) return svg;
  const box = svgViewBox(svg);
  if (!box) return svg;
  const rootStart = svg.search(/<svg\b/i);
  const openEnd = rootStart < 0 ? -1 : svg.indexOf(">", rootStart);
  const closeStart = svg.lastIndexOf("</svg>");
  if (openEnd < 0 || closeStart < openEnd) return svg;

  const marks = strokes.map((stroke) => erasureMarkup(stroke, box, pixelExact)).join("");
  const mask = `<defs><mask id="${MASK_ID}" maskUnits="userSpaceOnUse" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" mask-type="luminance" style="mask-type:luminance" color-interpolation="sRGB"><rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" fill="#fff"/>${marks}</mask></defs>`;
  return `${svg.slice(0, openEnd + 1)}${mask}<g mask="url(#${MASK_ID})">${svg.slice(openEnd + 1, closeStart)}</g>${svg.slice(closeStart)}`;
}

/**
 * Apply ordered eraser and fill strokes to an SVG. An eraser wraps all
 * artwork produced before it, while a later fill remains visible above
 * that mask. This mirrors the order in which cleanup actions were drawn.
 */
export function applyCleanupActions(svg, actions, { pixelExact = false } = {}) {
  if (!actions.length) return svg;
  const box = svgViewBox(svg);
  const parts = svgParts(svg);
  if (!box || !parts) return svg;

  let content = parts.content;
  let defs = "";
  let maskIndex = 0;
  for (const action of actions) {
    if (action.mode === "fill") {
      content += fillMarkup(action, box, pixelExact);
      continue;
    }
    const id = `${CLEANUP_MASK_ID}-${maskIndex++}`;
    const mark = erasureMarkup(action, box, pixelExact);
    defs += `<mask id="${id}" maskUnits="userSpaceOnUse" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" mask-type="luminance" style="mask-type:luminance" color-interpolation="sRGB"><rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" fill="#fff"/>${mark}</mask>`;
    content = `<g mask="url(#${id})">${content}</g>`;
  }
  const definitions = defs ? `<defs>${defs}</defs>` : "";
  return `${parts.before}${definitions}${content}${parts.after}`;
}
