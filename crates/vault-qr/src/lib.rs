//! Reading QR codes for Neptune Vault: camera frames and pictures.
//!
//! One reader everywhere: rxing, a Rust port of ZXing, built from this
//! source. The web app runs it as WebAssembly in the scanner's worker; the
//! desktop and Android apps run it natively, through vault-bridge. A
//! Standard address makes one of the densest codes there is (version 36 of
//! 40, 161 modules a side), so the reader is asked to look hard.

use rxing::{helpers, BarcodeFormat, DecodeHints};

/// The text of the QR code in a greyscale image, one byte a pixel, rows
/// from the top. None when there is no code to read, or when the pixels do
/// not match the size.
pub fn read_luma(luma: Vec<u8>, width: u32, height: u32) -> Option<String> {
    if width == 0 || height == 0 || luma.len() as u64 != u64::from(width) * u64::from(height) {
        return None;
    }
    let mut hints = DecodeHints {
        TryHarder: Some(true),
        ..DecodeHints::default()
    };
    helpers::detect_in_luma_with_hints(luma, width, height, Some(BarcodeFormat::QR_CODE), &mut hints)
        .ok()
        .map(|found| found.getText().to_string())
        .filter(|text| !text.is_empty())
}

/// The same from RGBA pixels, as a canvas gives them.
pub fn read_rgba(rgba: &[u8], width: u32, height: u32) -> Option<String> {
    if rgba.len() as u64 != u64::from(width) * u64::from(height) * 4 {
        return None;
    }
    read_luma(luma_of(rgba), width, height)
}

/// Greyscale from RGBA, weighted as the eye sees brightness (BT.601, in 256ths).
pub fn luma_of(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .map(|p| ((u32::from(p[0]) * 77 + u32::from(p[1]) * 150 + u32::from(p[2]) * 29) >> 8) as u8)
        .collect()
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// For the web app's scanner: the text of the QR code in RGBA pixels, or undefined.
    #[wasm_bindgen(js_name = readQr)]
    pub fn read_qr(rgba: &[u8], width: u32, height: u32) -> Option<String> {
        super::read_rgba(rgba, width, height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rxing::qrcode::QRCodeWriter;
    use rxing::{EncodeHints, Writer};

    /// A code as a camera might see it: `scale` pixels a module, on white.
    fn image_of(text: &str, scale: u32) -> (Vec<u8>, u32) {
        let hints = EncodeHints {
            ErrorCorrection: Some("L".to_string()),
            Margin: Some("2".to_string()),
            CharacterSet: Some("UTF-8".to_string()),
            ..EncodeHints::default()
        };
        let matrix = QRCodeWriter.encode_with_hints(text, &BarcodeFormat::QR_CODE, 0, 0, &hints).unwrap();
        let side = matrix.getWidth() * scale;
        let mut luma = vec![255u8; (side * side) as usize];
        for y in 0..side {
            for x in 0..side {
                if matrix.get(x / scale, y / scale) {
                    luma[(y * side + x) as usize] = 0;
                }
            }
        }
        (luma, side)
    }

    /// As the app writes a Standard address into a code: upper case, so it fits as alphanumeric.
    fn standard_address() -> String {
        let chars = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
        let body: String = (0..3476).map(|i| chars[(i * 7 + i / 5) % chars.len()] as char).collect();
        format!("NEPTUNECASH:NOLGAM1{}", body.to_uppercase())
    }

    #[test]
    fn reads_a_standard_address() {
        let text = standard_address();
        let (luma, side) = image_of(&text, 3);
        assert_eq!(read_luma(luma, side, side), Some(text));
    }

    #[test]
    fn reads_a_payment_request_with_a_name_in_utf8() {
        // A short address: this writer puts all of a text with lower case in
        // byte mode, where a Standard address and a request no longer fit.
        let text = "NEPTUNECASH:NOLGAM1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L?amount=12.5&label=Lena's café&message=Invoice%202026-114";
        let (luma, side) = image_of(text, 3);
        assert_eq!(read_luma(luma, side, side).as_deref(), Some(text));
    }

    #[test]
    fn reads_rgba_as_a_canvas_gives_it() {
        let text = "NEPTUNECASH:NOLGAM1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L";
        let (luma, side) = image_of(text, 4);
        let rgba: Vec<u8> = luma.iter().flat_map(|&v| [v, v, v, 255]).collect();
        assert_eq!(read_rgba(&rgba, side, side).as_deref(), Some(text));
    }

    #[test]
    fn finds_nothing_in_a_blank_frame() {
        assert_eq!(read_luma(vec![200; 928 * 928], 928, 928), None);
    }

    /// Most frames a camera sends hold no code, and a panic in the browser
    /// would leave the reader unusable.
    #[test]
    fn finds_nothing_without_a_panic_in_odd_frames() {
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut noise = |n: u32| -> Vec<u8> {
            (0..n)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    (state >> 24) as u8
                })
                .collect()
        };
        let mut frames = vec![];
        for (w, h) in [(1, 1), (2, 2), (1, 100), (100, 1), (3000, 1), (20, 20), (21, 21), (7, 500)] {
            frames.push((vec![0; (w * h) as usize], w, h));
            frames.push((noise(w * h), w, h));
        }
        for (w, h) in [(640, 480), (928, 928), (1280, 720)] {
            frames.push((noise(w * h), w, h));
        }
        // Checks and stripes, which look like finder patterns to a detector.
        for period in [1, 3, 7] {
            let checks = (0..640 * 480).map(|i| if ((i % 640) / period + (i / 640) / period) % 2 == 0 { 0 } else { 255 });
            frames.push((checks.collect(), 640, 480));
            let stripes = (0..640 * 480).map(|i| if ((i % 640) / period) % 2 == 0 { 0 } else { 255 });
            frames.push((stripes.collect(), 640, 480));
        }
        for (luma, w, h) in frames {
            assert_eq!(read_luma(luma, w, h), None, "a {w}x{h} frame");
        }
    }

    #[test]
    fn refuses_pixels_that_do_not_match_the_size() {
        assert_eq!(read_luma(vec![0; 99], 10, 10), None);
        assert_eq!(read_rgba(&[0; 100], 10, 10), None);
        assert_eq!(read_luma(vec![], 0, 0), None);
    }
}
