//! WASM bindings around vtracer for the RasterTrace web app.
//!
//! Mirrors the vtracer invocation used by RasterTrace:
//! color mode, stacked hierarchy, and the same tunable parameters.

use vtracer::{Clustering, ColorImage, Config, FitMode, Hierarchical};
use wasm_bindgen::prelude::*;

/// Trace an RGBA pixel buffer into an SVG document string.
///
/// `pixels` is tightly packed RGBA, `width * height * 4` bytes.
/// `mode` is "spline", "polygon", or "none" (pixel-perfect).
/// `hierarchical` is "stacked" (shapes layered on top of each other) or
/// "cutout" (non-overlapping adjacent shapes). `color_mode` is "color" or
/// "binary" (black/white stencil keyed on r < 128). Remaining parameters
/// match the vtracer `Config` fields of the same names.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn trace(
    pixels: &[u8],
    width: usize,
    height: usize,
    mode: &str,
    hierarchical: &str,
    color_mode: &str,
    filter_speckle: usize,
    color_precision: i32,
    layer_difference: i32,
    corner_threshold: i32,
    length_threshold: f64,
    max_iterations: usize,
    splice_threshold: i32,
    path_precision: u32,
) -> Result<String, JsError> {
    if width == 0 || height == 0 {
        return Err(JsError::new("image dimensions must be non-zero"));
    }
    let expected = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| JsError::new("image dimensions overflow"))?;
    if pixels.len() != expected {
        return Err(JsError::new(&format!(
            "pixel buffer length {} does not match {}x{} RGBA ({} bytes)",
            pixels.len(),
            width,
            height,
            expected
        )));
    }

    let mode = match mode {
        "spline" => FitMode::Spline,
        "polygon" => FitMode::Polygon,
        "none" => FitMode::Pixel,
        other => return Err(JsError::new(&format!("unknown mode: {other}"))),
    };

    let hierarchical = match hierarchical {
        "stacked" => Hierarchical::Stacked,
        "cutout" => Hierarchical::Cutout,
        other => return Err(JsError::new(&format!("unknown hierarchical: {other}"))),
    };

    let clustering = match color_mode {
        "color" => Clustering::ColorCluster,
        "binary" => Clustering::Binary,
        other => return Err(JsError::new(&format!("unknown color_mode: {other}"))),
    };

    let img = ColorImage {
        pixels: pixels.to_vec(),
        width,
        height,
    };
    let config = Config {
        clustering,
        hierarchical,
        mode,
        filter_speckle,
        color_precision,
        layer_difference,
        corner_threshold,
        length_threshold,
        max_iterations,
        splice_threshold,
        path_precision: Some(path_precision),
        // RasterTrace groups fills and optionally minifies after line
        // straightening. Keep absolute M/L/C commands at this boundary so
        // those tools, the eraser, and the PDF/DXF exporters share one shape.
        optimize: 0,
        ..Config::default()
    };

    config
        .build()
        .map_err(|e| JsError::new(&e.to_string()))?
        .to_svg(&img)
        .map_err(|e| JsError::new(&e.to_string()))
}
