use super::*;

#[test]
fn test_base64_roundtrip_ascii_utf8_and_empty() {
    for sample in ["", "hello world", r"C:\Users\demo\image.png", r"C:\写真\日本語\テスト.png"] {
        let encoded = base64_encode(sample.as_bytes());
        assert_eq!(base64_decode(&encoded).as_deref(), Some(sample));
        assert_eq!(base64_decode_bytes(&encoded).as_deref(), Some(sample.as_bytes()));
    }
}

#[test]
fn test_base64_decode_bytes_variants_and_errors() {
    // 6-byte payload produces '+' and '/' in standard base64 without padding.
    let binary = &[0xfb, 0xff, 0xfe, 0x00, 0x01, 0x3f];
    let standard = base64_encode(binary);
    assert!(standard.contains('+'));
    assert!(standard.contains('/'));
    let url_safe = standard.replace('+', "-").replace('/', "_");
    assert_eq!(base64_decode_bytes(&standard).as_deref(), Some(binary.as_slice()));
    assert_eq!(base64_decode_bytes(&url_safe).as_deref(), Some(binary.as_slice()));

    // 5-byte payload produces '+', '/', and '=' padding so all four variants differ.
    let padded_binary = &[0xfb, 0xff, 0xfe, 0x00, 0x01];
    let std_padded = base64_encode(padded_binary);
    assert!(std_padded.ends_with('='));
    let std_unpadded = std_padded.trim_end_matches('=');
    let url_padded = std_padded.replace('+', "-").replace('/', "_");
    let url_unpadded = std_unpadded.replace('+', "-").replace('/', "_");

    for variant in [&std_padded[..], std_unpadded, &url_padded[..], &url_unpadded[..]] {
        assert_eq!(
            base64_decode_bytes(variant).as_deref(),
            Some(padded_binary.as_slice())
        );
    }

    // 4-byte payload produces '==' double padding; verify all four variants decode cleanly.
    let double_padded_binary = &[0xfb, 0xff, 0xfe, 0x00];
    let std_double_padded = base64_encode(double_padded_binary);
    assert!(std_double_padded.ends_with("=="));
    let std_double_unpadded = std_double_padded.trim_end_matches('=');
    let url_double_padded = std_double_padded.replace('+', "-").replace('/', "_");
    let url_double_unpadded = std_double_unpadded.replace('+', "-").replace('/', "_");

    for variant in [
        &std_double_padded[..],
        std_double_unpadded,
        &url_double_padded[..],
        &url_double_unpadded[..],
    ] {
        assert_eq!(
            base64_decode_bytes(variant).as_deref(),
            Some(double_padded_binary.as_slice())
        );
    }

    assert_eq!(base64_decode_bytes("!!!not-base64!!!"), None);
    assert_eq!(base64_decode_bytes("abcde"), None);
    // Mixed URL-safe and standard alphabet characters are rejected.
    assert_eq!(base64_decode_bytes("-+/="), None);

    // Valid base64 of invalid UTF-8 decodes as bytes but not as a UTF-8 string.
    let invalid_utf8 = &[0xff, 0xfe, 0xfd];
    let encoded_invalid_utf8 = base64_encode(invalid_utf8);
    assert_eq!(
        base64_decode_bytes(&encoded_invalid_utf8).as_deref(),
        Some(invalid_utf8.as_slice())
    );
    assert_eq!(base64_decode(&encoded_invalid_utf8), None);
}

#[test]
fn test_url_decode() {
    assert_eq!(url_decode(""), "");
    assert_eq!(url_decode("plain/path/file.png"), "plain/path/file.png");
    assert_eq!(url_decode(r"C:\写真\日本語\file.png"), r"C:\写真\日本語\file.png");
    assert_eq!(url_decode("hello%20world%2F%E6%97%A5"), "hello world/日");
    assert_eq!(url_decode("%"), "%");
    assert_eq!(url_decode("%2"), "%2");
    assert_eq!(url_decode("%ZZ"), "%ZZ");
    assert_eq!(url_decode("100%"), "100%");
}
