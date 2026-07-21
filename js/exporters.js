// Export pipeline and save handlers: applies export post-processing to
// the traced SVG, drives the result stats and action buttons, and saves
// SVG/PNG/PDF/DXF through the File System Access API or a download.
import { applyEraserMask } from "./eraser.js?v=4";
import { applyExportOptions, countPaths } from "./preprocess.js?v=42";
import { parseSvgPaths, toDxf, toPdf } from "./vectorexport.js?v=39";
import { els, preferences, showError, state } from "./context.js?v=2";

const DISPLAY_UNITS_PER_INCH = { px: 96, in: 1, cm: 2.54, mm: 25.4 };

export function setResultActions(enabled) {
  els.copySvg.disabled = !enabled;
  els.downloadPng.disabled = !enabled;
  els.downloadPdf.disabled = !enabled;
  els.downloadDxf.disabled = !enabled;
  els.download.disabled = !enabled;
  for (const button of document.querySelectorAll('.menu-popover [data-result-action], [data-action="save-svg"]')) {
    button.disabled = !enabled;
  }
  els.eraserTool.disabled = !enabled;
  els.eraserSize.disabled = !enabled;
  els.marqueeRect.disabled = !enabled;
  els.marqueeEllipse.disabled = !enabled;
  els.polygonLasso.disabled = !enabled;
  const erased = enabled && state.eraseStrokes.length > 0;
  els.eraserUndo.disabled = !erased;
  els.eraserRedo.disabled = !enabled || !state.eraseRedo.length;
  els.eraserClear.disabled = !erased;
  if (erased) {
    els.downloadPdf.disabled = true;
    els.downloadDxf.disabled = true;
    els.downloadPdf.title = "Clear eraser strokes before exporting PDF";
    els.downloadDxf.title = "Clear eraser strokes before exporting DXF";
  } else {
    els.downloadPdf.title = "Save a vector PDF at the selected physical size, choosing its name and location";
    els.downloadDxf.title = "Save DXF geometry for CAD or fabrication, choosing its name and location";
  }
  for (const button of document.querySelectorAll('[data-action="download-pdf"], [data-action="download-dxf"]')) {
    button.disabled = !enabled || erased;
  }
}

/** Export post-processing options from the SVG export controls. */
function exportOptions() {
  const opts = {};
  // Minified drops the accessibility title too; otherwise the file name
  // becomes the <title> so standalone SVGs have an accessible name.
  if (els.minify.checked) opts.minify = true;
  else opts.title = state.fileName.replace(/\.[^.]+$/, "");
  if (els.exportSize.value === "physical") {
    const width = Number(els.physicalWidth.value);
    if (width > 0) {
      opts.physicalWidth = width;
      opts.physicalUnit = els.physicalUnit.value;
    }
  }
  return opts;
}

export function updatePhysicalHeightOut() {
  const width = Number(els.physicalWidth.value);
  if (els.exportSize.value !== "physical" || !state.sourceWidth || !(width > 0)) {
    els.physicalHeightOut.textContent = "";
    return;
  }
  const height = Number((width * (state.sourceHeight / state.sourceWidth)).toFixed(2));
  els.physicalHeightOut.textContent = `× ${height} ${els.physicalUnit.value}`;
}

/**
 * Re-apply export post-processing (physical size, title, minify) to the
 * last trace and refresh preview, stats, and download. Pure string work:
 * export option changes never re-trace.
 */
export function refreshExport() {
  if (!state.svgRaw) return { paths: 0 };
  state.svg = applyEraserMask(applyExportOptions(state.svgRaw, exportOptions()), state.eraseStrokes);

  // Rendered via <img> + blob URL: sandboxes the generated markup and
  // avoids inflating the DOM with thousands of inline path nodes.
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  const blob = new Blob([state.svg], { type: "image/svg+xml" });
  state.downloadUrl = URL.createObjectURL(blob);
  els.resultView.src = state.downloadUrl;

  const paths = countPaths(state.svg);
  const kb = blob.size / 1024;
  els.statPaths.textContent = paths.toLocaleString();
  els.statSize.textContent = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
  setResultActions(true);
  updatePhysicalHeightOut();
  return { paths };
}

els.copySvg.addEventListener("click", async () => {
  if (!state.svgRaw) return;
  try {
    refreshExport();
    const svg = state.svg;
    await navigator.clipboard.writeText(svg);
    els.status.textContent = "SVG copied to clipboard.";
  } catch {
    els.status.textContent = "Clipboard unavailable. Use Save As instead.";
  }
});

function formatDimensionsFromInches(width, height) {
  const unit = preferences.measurementUnit;
  const displayWidth = width * DISPLAY_UNITS_PER_INCH[unit];
  const displayHeight = height * DISPLAY_UNITS_PER_INCH[unit];
  const digits = unit === "px" ? 0 : unit === "in" ? 2 : 1;
  return `${displayWidth.toFixed(digits)}×${displayHeight.toFixed(digits)} ${unit}`;
}

function exportFileName(extension) {
  return `${state.fileName.replace(/\.[^.]+$/, "")}.${extension}`;
}

function downloadBlob(blob, extension) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(extension);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function chooseSaveFile(extension, mimeType) {
  if (!("showSaveFilePicker" in window)) return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName: exportFileName(extension),
      types: [{
        description: `${extension.toUpperCase()} file`,
        accept: { [mimeType]: [`.${extension}`] },
      }],
    });
  } catch (err) {
    if (err?.name === "AbortError") return undefined;
    throw err;
  }
}

async function saveBlob(blob, extension, fileHandle) {
  if (fileHandle === undefined) return { cancelled: true };
  if (!fileHandle) {
    downloadBlob(blob, extension);
    return { downloaded: true };
  }
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return { name: fileHandle.name };
}

function saveStatus(format, result, detail = "") {
  if (result.downloaded) return `${format} export sent to your browser downloads${detail}.`;
  return `${format} saved as ${result.name}${detail}.`;
}

els.download.addEventListener("click", async () => {
  if (!state.svgRaw || els.download.disabled) return;
  try {
    const fileHandle = await chooseSaveFile("svg", "image/svg+xml");
    if (fileHandle === undefined) return;
    refreshExport();
    const svg = state.svg;
    const result = await saveBlob(new Blob([svg], { type: "image/svg+xml" }), "svg", fileHandle);
    if (!result.cancelled) els.status.textContent = saveStatus("SVG", result);
  } catch (err) {
    showError(err.message || "SVG export failed.");
  }
});

// PNG render at the trace resolution (viewBox), not the display size:
// engraving and upload tools that reject SVG get the full detail.
els.downloadPng.addEventListener("click", async () => {
  if (!state.svgRaw || els.downloadPng.disabled) return;
  let renderUrl = null;
  try {
    const fileHandle = await chooseSaveFile("png", "image/png");
    if (fileHandle === undefined) return;
    refreshExport();
    const svg = state.svg;
    els.downloadPng.disabled = true;
    const img = new Image();
    renderUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.src = renderUrl;
    await img.decode();
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    const width = m ? Number(m[1]) : img.naturalWidth;
    const height = m ? Number(m[2]) : img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const result = await saveBlob(blob, "png", fileHandle);
    els.status.textContent = saveStatus("PNG", result, ` at ${width}×${height} px`);
  } catch (err) {
    showError(err.message || "PNG export failed.");
  } finally {
    if (renderUrl) URL.revokeObjectURL(renderUrl);
    els.downloadPng.disabled = false;
  }
});

/** Physical export width in the given output unit, or null when off. */
function physicalWidthIn(unitsPerMm, unitsPerInch) {
  if (els.exportSize.value !== "physical") return null;
  const width = Number(els.physicalWidth.value);
  if (!(width > 0)) return null;
  const unit = els.physicalUnit.value;
  if (unit === "px") return null;
  if (unit === "in") return width * unitsPerInch;
  return width * unitsPerMm * (unit === "cm" ? 10 : 1);
}

els.downloadPdf.addEventListener("click", async () => {
  if (!state.svgRaw || els.downloadPdf.disabled || state.eraseStrokes.length) return;
  try {
    const parsed = parseSvgPaths(state.svgRaw);
    // Page size in points: the physical size when set, else source
    // pixels at 96 dpi (72/96 pt per px).
    const widthPt = physicalWidthIn(72 / 25.4, 72) ?? state.sourceWidth * 0.75;
    const heightPt = widthPt * (state.sourceHeight / state.sourceWidth);
    const pdf = toPdf(parsed, { pageWidth: widthPt, pageHeight: heightPt });
    const fileHandle = await chooseSaveFile("pdf", "application/pdf");
    if (fileHandle === undefined || state.eraseStrokes.length) return;
    const result = await saveBlob(new Blob([pdf], { type: "application/pdf" }), "pdf", fileHandle);
    if (!result.cancelled) {
      els.status.textContent = saveStatus("PDF", result, ` at ${formatDimensionsFromInches(widthPt / 72, heightPt / 72)}`);
    }
  } catch (err) {
    showError(err.message || "PDF export failed.");
  }
});

els.downloadDxf.addEventListener("click", async () => {
  if (!state.svgRaw || els.downloadDxf.disabled || state.eraseStrokes.length) return;
  try {
    const parsed = parseSvgPaths(state.svgRaw);
    // DXF units: mm when a physical size is set, else source pixels.
    const widthUnits = physicalWidthIn(1, 25.4) ?? state.sourceWidth;
    const dxf = toDxf(parsed, { scale: widthUnits / parsed.width });
    const fileHandle = await chooseSaveFile("dxf", "image/vnd.dxf");
    if (fileHandle === undefined || state.eraseStrokes.length) return;
    const result = await saveBlob(new Blob([dxf], { type: "image/vnd.dxf" }), "dxf", fileHandle);
    if (!result.cancelled) {
      const detail = els.exportSize.value === "physical"
        ? ` at ${widthUnits.toFixed(1)} mm wide`
        : ` at ${widthUnits} units (source pixels)`;
      els.status.textContent = saveStatus("DXF", result, detail);
    }
  } catch (err) {
    showError(err.message || "DXF export failed.");
  }
});
