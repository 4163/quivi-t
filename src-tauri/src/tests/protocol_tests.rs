use super::{
    entry_response, guess_mime, parse_archive_url, parse_byte_range, parse_icon_url,
    parse_thumb_url, png_response, ByteRange,
};

#[test]
fn guess_mime_matches_known_image_extensions_case_insensitively() {
    assert_eq!(guess_mime("page.JPG"), "image/jpeg");
    assert_eq!(guess_mime("cover.WebP"), "image/webp");
    assert_eq!(guess_mime("icon.ICO"), "image/x-icon");
    assert_eq!(guess_mime("bitmap.DIB"), "image/bmp");
    assert_eq!(guess_mime("notes.txt"), "application/octet-stream");
}

#[test]
fn parse_archive_url_decodes_path_and_entry_name() {
    let archive_path = "E:\\Comics\\Issue 01.cbz";
    let encoded_path = crate::utils::base64_encode(archive_path.as_bytes());
    let url = format!("http://quivit.localhost/archive/{encoded_path}/Folder%201%2Fpage%2001.JPG");

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
fn parse_thumb_url_decodes_path() {
    let path = "E:\\Photos\\vacation.jpg";
    let encoded = crate::utils::base64_encode(path.as_bytes());
    let url = format!("http://quivit.localhost/thumb/{encoded}");

    let parsed = parse_thumb_url(&url).expect("parse thumb URL");
    assert_eq!(parsed, path);

    let url_query = format!("http://quivit.localhost/thumb/{encoded}?_t=123");
    let parsed2 = parse_thumb_url(&url_query).expect("parse thumb URL with query");
    assert_eq!(parsed2, path);
}

#[test]
fn parse_thumb_url_rejects_malformed_urls() {
    assert!(parse_thumb_url("quivit://localhost/not-thumb/path").is_err());
    assert!(parse_thumb_url("quivit://localhost/thumb/not-valid-base64!!!").is_err());
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
    assert_eq!(response.headers()["Cache-Control"], "no-store");
    assert_eq!(response.body(), &vec![1, 2, 3]);
}

#[test]
fn entry_response_ignores_invalid_byte_ranges() {
    let response = entry_response("page.jpg", &[0, 1, 2, 3, 4], Some("bytes=10-11"));

    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["Accept-Ranges"], "bytes");
    assert_eq!(response.headers()["Content-Length"], "5");
    assert_eq!(response.headers()["Cache-Control"], "no-store");
    assert_eq!(response.body(), &vec![0, 1, 2, 3, 4]);
}

#[test]
fn entry_response_uses_no_store_cache_control() {
    let response = entry_response("page.jpg", &[0, 1, 2], None);
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["Cache-Control"], "no-store");
}

#[test]
fn entry_response_serves_suffix_byte_range() {
    let data = vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    let response = entry_response("image.png", &data, Some("bytes=-4"));

    assert_eq!(response.status(), 206);
    assert_eq!(response.headers()["Content-Range"], "bytes 6-9/10");
    assert_eq!(response.headers()["Content-Length"], "4");
    assert_eq!(response.body(), &vec![6, 7, 8, 9]);
}

#[test]
fn entry_response_serves_open_ended_byte_range() {
    let data = vec![10, 20, 30, 40, 50, 60, 70];
    let response = entry_response("image.webp", &data, Some("bytes=4-"));

    assert_eq!(response.status(), 206);
    assert_eq!(response.headers()["Content-Range"], "bytes 4-6/7");
    assert_eq!(response.headers()["Content-Length"], "3");
    assert_eq!(response.body(), &vec![50, 60, 70]);
}

#[test]
fn entry_response_single_byte_ranges() {
    let data = vec![100, 101, 102, 103, 104];
    let first = entry_response("photo.jpg", &data, Some("bytes=0-0"));
    assert_eq!(first.status(), 206);
    assert_eq!(first.headers()["Content-Range"], "bytes 0-0/5");
    assert_eq!(first.headers()["Content-Length"], "1");
    assert_eq!(first.body(), &vec![100]);

    let last = entry_response("photo.jpg", &data, Some("bytes=4-4"));
    assert_eq!(last.status(), 206);
    assert_eq!(last.headers()["Content-Range"], "bytes 4-4/5");
    assert_eq!(last.headers()["Content-Length"], "1");
    assert_eq!(last.body(), &vec![104]);
}

#[test]
fn entry_response_empty_body_and_zero_len() {
    let empty: [u8; 0] = [];
    let resp = entry_response("empty.bin", &empty, None);
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["Content-Length"], "0");
    assert!(resp.body().is_empty());

    let resp_range = entry_response("empty.bin", &empty, Some("bytes=0-0"));
    assert_eq!(resp_range.status(), 200);
    assert_eq!(resp_range.headers()["Content-Length"], "0");
    assert!(resp_range.body().is_empty());
}

#[test]
fn entry_response_content_type_mapping_across_formats() {
    let dummy = [1u8, 2, 3];
    assert_eq!(
        entry_response("img.png", &dummy, None).headers()["Content-Type"],
        "image/png"
    );
    assert_eq!(
        entry_response("img.webp", &dummy, None).headers()["Content-Type"],
        "image/webp"
    );
    assert_eq!(
        entry_response("img.gif", &dummy, None).headers()["Content-Type"],
        "image/gif"
    );
    assert_eq!(
        entry_response("img.svg", &dummy, None).headers()["Content-Type"],
        "image/svg+xml"
    );
    assert_eq!(
        entry_response("img.avif", &dummy, None).headers()["Content-Type"],
        "image/avif"
    );
    assert_eq!(
        entry_response("img.bmp", &dummy, None).headers()["Content-Type"],
        "image/bmp"
    );
    assert_eq!(
        entry_response("img.ico", &dummy, None).headers()["Content-Type"],
        "image/x-icon"
    );
}

#[test]
fn png_response_contract() {
    let png_payload = vec![137, 80, 78, 71, 13, 10, 26, 10];
    let resp = png_response(png_payload.clone());
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["Content-Type"], "image/png");
    assert_eq!(
        resp.headers()["Content-Length"],
        png_payload.len().to_string()
    );
    assert_eq!(resp.headers()["Cache-Control"], "public, max-age=86400");
    assert_eq!(resp.headers()["Access-Control-Allow-Origin"], "*");
    assert_eq!(resp.body(), &png_payload);
}
