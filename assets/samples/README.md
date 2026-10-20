# Sample images

The PNGs are canonical browser samples, generated from `src/*.svg`.
From the repository root, render and quantize each sample:

```sh
inkscape assets/samples/src/synthwave.svg -o /tmp/synthwave.png
magick /tmp/synthwave.png -strip -colors 64 PNG8:assets/samples/synthwave.png
```

Replace `synthwave` with the sample name. Text renders with locally installed
fonts, using DejaVu Sans and DejaVu Sans Mono for the branded samples.
