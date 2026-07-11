# RasterTrace

Convert raster images to clean, scalable SVG vectors entirely in your browser. [vtracer](https://github.com/visioncortex/vtracer) compiled to WebAssembly plus a Canvas/JS preprocessing stage. Images never leave your machine: no upload, no backend.

**Live app: https://rastertrace.com/**

## Features

- PNG, JPEG, WebP, GIF, BMP input (anything the browser decodes)
- Premultiplied-alpha upscaling (no edge halos), binary alpha (no fringe fragmentation)
- Median-cut + k-means color quantization with transparent-area backfill
- 3x3 majority filter to clean quantization dither
- Optional denoise blur for photographic sources
- Background removal: auto-detect from corners, hex color, or eyedropper pick from the image; edge trim chokes the cutout to remove leftover fringe
- Color-count presets from 2 to 256 with matched cleanup levels: fewer colors get more aggressive speckle and layer cleanup for flat print-style output
- Flat-image detection: logos, text, and pixel art are detected at load; the color count snaps to the image and crisp settings apply automatically, with every control still editable.
- Crisp edges toggle: sharper corner tracing for hard-edged sources; auto-enabled by detection, available manually for any image.
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
