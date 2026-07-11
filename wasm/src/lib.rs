//! WASM bindings around vtracer for the RasterTrace web app.
//!
//! Mirrors the vtracer invocation used by RasterTrace:
//! color mode, stacked hierarchy, and the same tunable parameters.

use visioncortex::{ColorImage, PathSimplifyMode};
use vtracer::{ColorMode, Config, Hierarchical};
use wasm_bindgen::prelude::*;

/// Trace an RGBA pixel buffer into an SVG document string.
///
/// `pixels` is tightly packed RGBA, `width * height * 4` bytes.
/// `mode` is "spline" or "polygon". Remaining parameters match the
/// vtracer `Config` fields of the same names.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn trace(
    pixels: &[u8],
    width: usize,
    height: usize,
    mode: &str,
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
        "spline" => PathSimplifyMode::Spline,
        "polygon" => PathSimplifyMode::Polygon,
        other => return Err(JsError::new(&format!("unknown mode: {other}"))),
    };

    let img = ColorImage {
        pixels: pixels.to_vec(),
        width,
        height,
    };
    let config = Config {
        color_mode: ColorMode::Color,
        hierarchical: Hierarchical::Stacked,
        mode,
        filter_speckle,
        color_precision,
        layer_difference,
        corner_threshold,
        length_threshold,
        max_iterations,
        splice_threshold,
        path_precision: Some(path_precision),
    };

    let svg = vtracer::convert(img, config).map_err(|e| JsError::new(&e))?;
    Ok(svg.to_string())
}
