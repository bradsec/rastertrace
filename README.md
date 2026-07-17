# RasterTrace

Convert raster images to clean, scalable SVG vectors entirely in your browser. [vtracer](https://github.com/visioncortex/vtracer) compiled to WebAssembly plus a Canvas/JS preprocessing stage. Images never leave your machine: no upload, no backend.

**Live app: https://rastertrace.com/**

## Features

- PNG, JPEG, WebP, GIF, BMP input (anything the browser decodes)
- Premultiplied-alpha upscaling (no edge halos), binary alpha (no fringe fragmentation)
- Median-cut + k-means color quantization in perceptual Oklab space with transparent-area backfill
- 3x3 majority filter to clean quantization dither
- Optional edge-preserving median denoise for photographic sources
- Background removal: auto-detect from border sampling, hex color, or eyedropper pick from the image; perceptual match tolerance; edge trim chokes the cutout and defringe repaints leftover fringe without shrinking thin details
- Purpose-based export profiles: Web optimized, Balanced, High detail, Print & cutting, and Laser stencil set colors, cleanup, path detail, and output options together (all controls stay editable)
- Stencil mode: true black/white binary tracing for laser cutting, stamps, and silhouettes, with an adjustable brightness threshold to pick up or drop midtones
- SVG size export: preserve source pixels or write a custom width/height in px, mm, cm, or in, with the viewBox preserved
- Minified output option, or accessible output with `role="img"` and a `<title>` from the file name
- Advanced tracing controls: path coordinate precision, curve segment length, spline splitting
- Color-count presets from 2 to 256 with matched cleanup levels: fewer colors get more aggressive speckle and layer cleanup for flat print-style output
- Flat-image detection: logos, text, and pixel art are detected at load; the color count snaps to the image, with every control still editable.
- Crisp edges toggle: sharper corner tracing for hard-edged sources, available manually for any image.
- Path modes: smooth splines, straight polygons, or pixel-exact outlines with nearest-neighbor upscaling for pixel art
- Corner rounding slider: fine control over how sharply angles trace, from hard corners to flowing curves
- Layering modes: stacked shapes (smallest files) or non-overlapping cutout shapes for laser cutting, vinyl, and CNC
- EXIF orientation respected: rotated phone photos load upright without distortion
- Invert (negative) toggle: trace the opposite regions, useful for stencils; composes with rotation and applies to the whole pipeline
- Paste an image from the clipboard (Ctrl/Cmd+V) to load it, alongside drag-and-drop and the file picker
- Same-fill paths grouped under shared `<g fill>` elements for smaller SVG files
- Upscale "Auto (fit 2048)" traces small images at the full 2048 px budget for maximum curve quality
- Live re-trace on setting changes, Save As dialogs for SVG, PNG, PDF, and DXF, clipboard copy, and PNG export at the trace resolution
- Vector PDF export (true curves, physical page size when set) for print shops and design handoff
- DXF export (R12) for CAD, CNC, and cutters: one closed polyline per shape, one layer per color, mm units when a physical size is set
- Settings persist across visits and image replacements (flat-image detection still tunes colors per image); one-click Reset settings
- Works offline after the first visit (service worker, everything stays local)
- Zoomable preview: pinch, scroll wheel, buttons, Fit, or Actual size (1:1); drag to pan
- Vector eraser with a zoom-aware circular cursor, adjustable diameter, `[` and `]` size shortcuts, undo/redo, and Restore Original. Cleanup masks are included in SVG and PNG exports.
- Photoshop-style rectangular and elliptical marquees plus a point-to-point polygonal lasso. Use `M`, `Shift+M`, or `L`, hold Shift to constrain proportions, hold Alt/Option to draw from center, then press Delete/Backspace to remove the selected area.
- Rotate the loaded image in 90 degree steps
- Trace size capped at 2048 px on the longest side: small images upscale for smoother curves, large photos downscale proportionally (the status line reports the applied scale). Opt-in Ultra mode raises the cap to 4096 px for the cleanest fabrication exports (slower, high memory)
- Guidance built in: photographic sources and high path counts get footer status suggestions, with the full settings guide available from Help
- Three-panel editor with a canvas-only center, independently scrolling controls, responsive mobile stacking, keyboard operation, and WCAG AA contrast

## Structure

```
index.html          app shell
sw.js               service worker: offline cache for the static app
css/styles.css      design tokens + layout
js/preprocess.js    pure pixel/string ops (Node-testable, no browser APIs)
js/vectorexport.js  DXF and PDF writers from traced SVG (Node-testable)
js/pipeline.js      decode, premultiplied rasterize, worker round-trip
js/worker.js        Web Worker: preprocessing + wasm trace off the main thread
js/app.js           UI wiring
pkg/                wasm-pack output (committed so Pages serves it as-is)
wasm/               Rust wrapper crate around vtracer
tests/              node --test unit tests
```

## Develop

```bash
npm test                 # unit tests (node --test)
npm run serve            # http://localhost:8137
npm run build:wasm       # rebuild pkg/ (needs rustup target wasm32-unknown-unknown + wasm-pack)
```

## Deploy

Static files only. The GitHub Actions workflow runs the tests and publishes the repository to GitHub Pages on every push to main.

## Browser support

Requires OffscreenCanvas and module workers: Chrome/Edge 109+, Firefox 111+, Safari 16.4+. Chrome and Edge offer native Save As dialogs; other supported browsers use their standard download flow because they do not expose a file-location picker to web pages.

## License

[MIT](LICENSE)
