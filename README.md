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
- Color-count presets from 2 to 256 with matched cleanup levels: fewer colors get more aggressive speckle and layer cleanup for flat print-style output
- Flat-image detection: logos, text, and pixel art are detected at load; the color count snaps to the image, with every control still editable.
- Crisp edges toggle: sharper corner tracing for hard-edged sources, available manually for any image.
- Path modes: smooth splines, straight polygons, or pixel-exact outlines with nearest-neighbor upscaling for pixel art
- Corner rounding slider: fine control over how sharply angles trace, from hard corners to flowing curves
- Layering modes: stacked shapes (smallest files) or non-overlapping cutout shapes for laser cutting, vinyl, and CNC
- EXIF orientation respected: rotated phone photos load upright without distortion
- Paste an image from the clipboard (Ctrl/Cmd+V) to load it, alongside drag-and-drop and the file picker
- Same-fill paths grouped under shared `<g fill>` elements for smaller SVG files
- Upscale "Auto (fit 2048)" traces small images at the full 2048 px budget for maximum curve quality
- Live re-trace on setting changes, SVG download and clipboard copy
- Zoomable preview: pinch, scroll wheel, or buttons; drag to pan
- Rotate the loaded image in 90 degree steps
- Trace size capped at 2048 px on the longest side: small images upscale for smoother curves, large photos downscale proportionally (the status line reports the applied scale)
- Responsive layout, keyboard operable, WCAG AA contrast

## Structure

```
index.html          app shell
css/styles.css      design tokens + layout
js/preprocess.js    pure pixel/string ops (Node-testable, no browser APIs)
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

Requires OffscreenCanvas and module workers: Chrome/Edge 109+, Firefox 111+, Safari 16.4+.

## License

[MIT](LICENSE)
