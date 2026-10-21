const MASK_ID = "rastertrace-eraser-mask";
const CLEANUP_MASK_ID = "rastertrace-cleanup-mask";

export function brushSizeForShortcut(value, increase, min, max) {
  const scaled = Math.round(value * (increase ? 1.2 : 1 / 1.2));
  const changed = increase ? Math.max(value + 1, scaled) : Math.min(value - 1, scaled);
  return Math.min(max, Math.max(min, changed));
}

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

/**
 * A cleanup action turned a quarter with the image. Action geometry is
 * normalized to the image (0..1 on each axis), so a turn swaps the axes
 * and mirrors one; brush diameters are relative to the shorter side and
 * stay as they are. Returns a new action and leaves the input untouched.
 */
export function rotateCleanupAction(action, clockwise) {
  const turn = (point) =>
    clockwise ? { x: 1 - point.y, y: point.x } : { x: point.y, y: 1 - point.x };
  if (action.type === "composite") {
    return {
      ...action,
      parts: action.parts.map((part) => ({
        ...part,
        shape: rotateCleanupAction(part.shape, clockwise),
      })),
    };
  }
  if (action.type === "rect") {
    return {
      ...action,
      x: clockwise ? 1 - action.y - action.height : action.y,
      y: clockwise ? action.x : 1 - action.x - action.width,
      width: action.height,
      height: action.width,
    };
  }
  if (action.type === "ellipse") {
    const center = turn({ x: action.cx, y: action.cy });
    return { ...action, cx: center.x, cy: center.y, rx: action.ry, ry: action.rx };
  }
  if (action.type === "region") {
    return {
      ...action,
      seeds: action.seeds.map(turn),
      loops: action.loops.map((loop) => loop.map(turn)),
    };
  }
  // Freehand strokes and polygons.
  return { ...action, points: action.points.map(turn) };
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

/**
 * Marks for a combined selection, in order: added parts in `addFill`,
 * subtracted parts in `subtractFill`, so later parts override earlier ones.
 */
function compositeMarkup(parts, box, addFill, subtractFill) {
  return parts
    .map((part) =>
      erasureMarkup(part.shape, box, false).replace(
        /fill="#000"/g,
        `fill="${part.op === "subtract" ? subtractFill : addFill}"`,
      ),
    )
    .join("");
}

function erasureMarkup(erasure, box, pixelExact) {
  if (erasure.type === "composite") return compositeMarkup(erasure.parts, box, "#000", "#fff");
  if (erasure.type === "rect") {
    return `<rect x="${n(box.x + erasure.x * box.width)}" y="${n(box.y + erasure.y * box.height)}" width="${n(erasure.width * box.width)}" height="${n(erasure.height * box.height)}" fill="#000"/>`;
  }
  if (erasure.type === "ellipse") {
    return `<ellipse cx="${n(box.x + erasure.cx * box.width)}" cy="${n(box.y + erasure.cy * box.height)}" rx="${n(erasure.rx * box.width)}" ry="${n(erasure.ry * box.height)}" fill="#000"/>`;
  }
  if (erasure.type === "region") {
    const d = erasure.loops
      .map(
        (loop) =>
          loop
            .map((point, index) => {
              const p = pointInBox(point, box);
              return `${index ? "L" : "M"}${n(p.x)} ${n(p.y)}`;
            })
            .join("") + "Z",
      )
      .join("");
    return `<path d="${d}" fill-rule="evenodd" fill="#000"/>`;
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

/**
 * Standalone SVG of one cleanup action's area, white on black, sized
 * `width` x `height`: the coverage mask for painting the action into a
 * raster before tracing. A combined selection's subtracted parts are
 * black, so they stay unpainted.
 */
export function cleanupMaskSvg(action, width, height, { pixelExact = false } = {}) {
  const box = { x: 0, y: 0, width, height };
  const marks =
    action.type === "composite"
      ? compositeMarkup(action.parts, box, "#fff", "#000")
      : erasureMarkup(action, box, pixelExact)
          .replace(/fill="#000"/g, 'fill="#fff"')
          .replace(/stroke="#000"/g, 'stroke="#fff"');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#000"/>${marks}</svg>`;
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
 * Smooth strokes are skipped.
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
    // Smoothing needs the traced colors, so it only shows once traced.
    if (action.mode === "smooth") continue;
    if (action.mode === "fill" && action.type === "composite") {
      // Subtracted parts must stay unpainted, so the color is masked
      // rather than drawn as recolored shapes.
      const id = `${CLEANUP_MASK_ID}-${maskIndex++}`;
      const area = `x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}"`;
      defs += `<mask id="${id}" maskUnits="userSpaceOnUse" ${area} mask-type="luminance" style="mask-type:luminance" color-interpolation="sRGB"><rect ${area} fill="#000"/>${compositeMarkup(action.parts, box, "#fff", "#000")}</mask>`;
      content += `<g mask="url(#${id})"><rect ${area} fill="${action.color}"/></g>`;
      continue;
    }
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
