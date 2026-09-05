use super::{
    entry_response, guess_mime, parse_archive_url, parse_byte_range, parse_icon_url, ByteRange,
};

#[test]
fn guess_mime_matches_known_image_extensions_case_insensitively() {
    assert_eq!(guess_mime("page.JPG"), "image/jpeg");
    assert_eq!(guess_mime("cover.WebP"), "image/webp");
    assert_eq!(guess_mime("icon.ICO"), "image/x-icon");
    assert_eq!(guess_mime("notes.txt"), "application/octet-stream");
}

#[test]
fn parse_archive_url_decodes_path_and_entry_name() {
    let archive_path = "E:\\Comics\\Issue 01.cbz";
    let encoded_path = crate::utils::base64_encode(archive_path.as_bytes());
    let url =
        format!("http://quivit.localhost/archive/{encoded_path}/Folder%201%2Fpage%2001.JPG");

    let (parsed_path, entry_name) = parse_archive_url(&url).expect("parse archive URL");

    assert_eq!(parsed_path, archive_path);
    assert_eq!(entry_name, "Folder 1/page 01.JPG");
}

#[test]
fn parse_archive_url_rejects_malformed_urls() {
    assert!(parse_archive_url("quivit://localhost/not-archive/path").is_err());
    assert!(parse_archive_url("quivit://localhost/archive/only-path").is_err());
    assert!(parse_archive_url("quivit://localhost/archive/not-base64/page.jpg").is_err());
}

#[test]
fn parse_icon_url_decodes_path_and_extension_key() {
    let path = "E:\\Comics\\Issue 01.cbz";
    let ext_key = "cbz";
    let encoded_path = crate::utils::base64_encode(path.as_bytes());
    let encoded_ext = crate::utils::base64_encode(ext_key.as_bytes());
    let url = format!("http://quivit.localhost/icon/{encoded_path}/{encoded_ext}");

    let (parsed_path, parsed_ext, size) = parse_icon_url(&url).expect("parse icon URL");

    assert_eq!(parsed_path, path);
    assert_eq!(parsed_ext, ext_key);
    assert_eq!(size, crate::platform::icons::IconSize::Small);

    let url_large = format!("http://quivit.localhost/icon/{encoded_path}/{encoded_ext}?size=large");
    let (p2, e2, s2) = parse_icon_url(&url_large).expect("parse large icon URL");
    assert_eq!(p2, path);
    assert_eq!(e2, ext_key);
    assert_eq!(s2, crate::platform::icons::IconSize::Large);
}

#[test]
fn parse_icon_url_rejects_malformed_urls() {
    assert!(parse_icon_url("quivit://localhost/not-icon/path").is_err());
    assert!(parse_icon_url("quivit://localhost/icon/only-path").is_err());
    assert!(parse_icon_url("quivit://localhost/icon/not-base64/Y2J6").is_err());
}

#[test]
fn parse_byte_range_handles_common_range_forms() {
    assert_eq!(
        parse_byte_range("bytes=2-5", 10),
        Some(ByteRange { start: 2, end: 5 })
    );
    assert_eq!(
        parse_byte_range("bytes=7-", 10),
        Some(ByteRange { start: 7, end: 9 })
    );
    assert_eq!(
        parse_byte_range("bytes=-3", 10),
        Some(ByteRange { start: 7, end: 9 })
    );
    assert_eq!(
        parse_byte_range("bytes=8-99", 10),
        Some(ByteRange { start: 8, end: 9 })
    );
    assert_eq!(
        parse_byte_range(" bytes=0-1 ", 10),
        Some(ByteRange { start: 0, end: 1 })
    );
}

#[test]
fn parse_byte_range_rejects_unsupported_ranges() {
    assert_eq!(parse_byte_range("items=0-1", 10), None);
    assert_eq!(parse_byte_range("bytes=9-1", 10), None);
    assert_eq!(parse_byte_range("bytes=10-11", 10), None);
    assert_eq!(parse_byte_range("bytes=-0", 10), None);
    assert_eq!(parse_byte_range("bytes=0-1,4-5", 10), None);
    assert_eq!(parse_byte_range("bytes=0-1", 0), None);
}

#[test]
fn entry_response_serves_valid_byte_ranges() {
    let response = entry_response("page.jpg", &[0, 1, 2, 3, 4], Some("bytes=1-3"));

    assert_eq!(response.status(), 206);
    assert_eq!(response.headers()["Accept-Ranges"], "bytes");
    assert_eq!(response.headers()["Content-Range"], "bytes 1-3/5");
    assert_eq!(response.headers()["Content-Length"], "3");
    assert_eq!(response.body(), &vec![1, 2, 3]);
}

#[test]
fn entry_response_ignores_invalid_byte_ranges() {
    let response = entry_response("page.jpg", &[0, 1, 2, 3, 4], Some("bytes=10-11"));

    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["Accept-Ranges"], "bytes");
    assert_eq!(response.headers()["Content-Length"], "5");
    assert_eq!(response.body(), &vec![0, 1, 2, 3, 4]);
}
