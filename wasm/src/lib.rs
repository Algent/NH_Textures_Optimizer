use std::num::NonZeroU64;

use oxipng::{Deflater, Options, StripChunks, ZopfliOptions};
use wasm_bindgen::prelude::*;

/// Lossless PNG optimisation. Colour type is never changed: Java ImageIO (used by Minecraft)
/// decodes grayscale PNGs with a linear colour space, so RGB -> gray would render brighter.
#[wasm_bindgen]
pub fn optimize(data: &[u8], level: u8, zopfli: bool) -> Result<Vec<u8>, JsError> {
    let mut opts = Options::from_preset(level);
    opts.color_type_reduction = false;
    opts.grayscale_reduction = false;
    opts.optimize_alpha = false;
    opts.strip = StripChunks::Safe;
    if zopfli {
        opts.deflater = Deflater::Zopfli(ZopfliOptions {
            iteration_count: NonZeroU64::new(15).unwrap(),
            ..Default::default()
        });
    }
    oxipng::optimize_from_memory(data, &opts).map_err(|e| JsError::new(&e.to_string()))
}
