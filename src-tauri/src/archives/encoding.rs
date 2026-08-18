/// Decode raw archive entry name bytes into a Unicode string.
/// UTF-8 fast-path, then chardetng statistical detection for legacy CJK
/// encodings (Shift-JIS, GBK, EUC-KR, BIG5, etc.), lossy fallback last.
pub(crate) fn decode_cjk_name(raw_bytes: &[u8]) -> String {
    if let Ok(utf8_str) = std::str::from_utf8(raw_bytes) {
        return utf8_str.to_string();
    }

    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    detector.feed(raw_bytes, true);

    let encoding = detector.guess(None, chardetng::Utf8Detection::Allow);
    let (decoded, _, had_errors) = encoding.decode(raw_bytes);

    if !had_errors {
        return decoded.into_owned();
    }

    String::from_utf8_lossy(raw_bytes).into_owned()
}
