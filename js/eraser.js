const MASK_ID = "rastertrace-eraser-mask";

export function svgViewBox(svg) {
  const match = svg.match(/\bviewBox\s*=\s*["']\s*([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)\s*["']/i);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return null;
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
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

function erasureMarkup(erasure, box) {
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

  const points = erasure.points.map((point) => pointInBox(point, box));
  const diameter = Math.max(0.01, erasure.diameter * Math.min(box.width, box.height));
  if (points.length === 1) {
    return `<circle cx="${n(points[0].x)}" cy="${n(points[0].y)}" r="${n(diameter / 2)}" fill="#000"/>`;
  }
  const d = points.map((point, index) => `${index ? "L" : "M"}${n(point.x)} ${n(point.y)}`).join(" ");
  return `<path d="${d}" fill="none" stroke="#000" stroke-width="${n(diameter)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

export function applyEraserMask(svg, strokes) {
  if (!strokes.length) return svg;
  const box = svgViewBox(svg);
  if (!box) return svg;
  const rootStart = svg.search(/<svg\b/i);
  const openEnd = rootStart < 0 ? -1 : svg.indexOf(">", rootStart);
  const closeStart = svg.lastIndexOf("</svg>");
  if (openEnd < 0 || closeStart < openEnd) return svg;

  const marks = strokes.map((stroke) => erasureMarkup(stroke, box)).join("");
  const mask = `<defs><mask id="${MASK_ID}" maskUnits="userSpaceOnUse" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" style="mask-type:luminance"><rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" fill="#fff"/>${marks}</mask></defs>`;
  return `${svg.slice(0, openEnd + 1)}${mask}<g mask="url(#${MASK_ID})">${svg.slice(openEnd + 1, closeStart)}</g>${svg.slice(closeStart)}`;
}
