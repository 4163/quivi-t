use std::sync::Arc;

use crate::formats::guess_mime;

use super::{
    archive_entry_response, clear_tiff_cache, entry_response, error_response, get_cached_tiff_png,
    insert_cached_tiff_png, invalidate_tiff_cache_for_archive, parse_archive_url, parse_byte_range,
    parse_icon_url, parse_route, parse_thumb_url, parse_tiff_url, serve_local_tiff, ByteRange,
    ProtocolRoute, TiffCacheKey, TiffPngCache,
};

#[test]
fn guess_mime_matches_known_image_extensions_case_insensitively() {
    assert_eq!(guess_mime("page.JPG"), "image/jpeg");
    assert_eq!(guess_mime("photo.JFIF"), "image/jpeg");
    assert_eq!(guess_mime("cover.WebP"), "image/webp");
    assert_eq!(guess_mime("icon.ICO"), "image/x-icon");
    assert_eq!(guess_mime("bitmap.DIB"), "image/bmp");
    assert_eq!(guess_mime("scan.TIF"), "image/tiff");
    assert_eq!(guess_mime("scan.TIFF"), "image/tiff");
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

    let url_32 = format!("http://quivit.localhost/icon/{encoded_path}/{encoded_ext}?size=32");
    let (p3, e3, s3) = parse_icon_url(&url_32).expect("parse 32px icon URL");
    assert_eq!(p3, path);
    assert_eq!(e3, ext_key);
    assert_eq!(s3, crate::platform::icons::IconSize::Large);
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
fn parse_tiff_url_decodes_path() {
    let path = "E:\\Scans\\page01.tiff";
    let encoded = crate::utils::base64_encode(path.as_bytes());
    let url = format!("http://quivit.localhost/tiff/{encoded}?_media=2");
    assert_eq!(parse_tiff_url(&url).expect("parse tiff URL"), path);
    assert!(parse_tiff_url("quivit://localhost/not-tiff/path").is_err());
}

#[test]
fn archive_entry_response_transcodes_tiff_to_png() {
    let mut tiff_bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::new(2, 2))
        .write_to(&mut std::io::Cursor::new(&mut tiff_bytes), image::ImageFormat::Tiff)
        .expect("encode test TIFF");

    let response = archive_entry_response("page.tiff", &tiff_bytes, None);
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["Content-Type"], "image/png");
    assert_eq!(response.headers()["Cache-Control"], "no-store");
    assert!(response.body().starts_with(b"\x89PNG\r\n\x1a\n"));

    let bad_tiff = archive_entry_response("corrupt.tif", b"not-a-tiff", None);
    assert_eq!(bad_tiff.status(), 422);
}

#[test]
fn parse_archive_url_preserves_route_like_entry_subpaths() {
    let archive_path = "E:\\Comics\\Pack.cbz";
    let encoded_path = crate::utils::base64_encode(archive_path.as_bytes());

    for subpath in ["icon/1.png", "thumb/1.png", "tiff/1.png"] {
        let url = format!("http://quivit.localhost/archive/{encoded_path}/{subpath}");
        let uri: tauri::http::Uri = url.parse().expect("valid test URI");
        assert_eq!(
            parse_route(&uri).expect("parse route for archive subpath"),
            ProtocolRoute::Archive {
                archive_path: archive_path.to_string(),
                entry_name: subpath.to_string(),
            }
        );

        let (parsed_path, entry_name) = parse_archive_url(&url).expect("parse archive subpath URL");
        assert_eq!(parsed_path, archive_path);
        assert_eq!(entry_name, subpath);
    }
}

#[test]
fn parse_route_dispatches_all_top_level_prefixes() {
    let encoded = crate::utils::base64_encode(b"C:\\folder\\file.tiff");
    let encoded_ext = crate::utils::base64_encode(b"tiff");

    let icon_uri: tauri::http::Uri =
        format!("http://quivit.localhost/icon/{encoded}/{encoded_ext}?size=32")
            .parse()
            .unwrap();
    assert_eq!(
        parse_route(&icon_uri).expect("icon route"),
        ProtocolRoute::Icon {
            path: "C:\\folder\\file.tiff".to_string(),
            ext_key: "tiff".to_string(),
            size: crate::platform::icons::IconSize::Large,
        }
    );

    let thumb_uri: tauri::http::Uri = format!("quivit://localhost/thumb/{encoded}?_t=1")
        .parse()
        .unwrap();
    assert_eq!(
        parse_route(&thumb_uri).expect("thumb route"),
        ProtocolRoute::Thumb {
            path: "C:\\folder\\file.tiff".to_string(),
        }
    );

    let tiff_uri: tauri::http::Uri = format!("http://quivit.localhost/tiff/{encoded}")
        .parse()
        .unwrap();
    assert_eq!(
        parse_route(&tiff_uri).expect("tiff route"),
        ProtocolRoute::Tiff {
            path: "C:\\folder\\file.tiff".to_string(),
        }
    );

    let unknown_uri: tauri::http::Uri = "http://quivit.localhost/other/foo".parse().unwrap();
    assert!(parse_route(&unknown_uri).is_err());
}

#[test]
fn tiff_png_cache_hits_evicts_and_invalidates_by_archive() {
    let mut cache = TiffPngCache::new(2, 16);
    let k1 = TiffCacheKey::Archive {
        archive_path: "a.cbz".to_string(),
        entry_name: "1.tif".to_string(),
    };
    let k2 = TiffCacheKey::Archive {
        archive_path: "a.cbz".to_string(),
        entry_name: "2.tif".to_string(),
    };
    let k3 = TiffCacheKey::Archive {
        archive_path: "b.cbz".to_string(),
        entry_name: "1.tif".to_string(),
    };

    let d1: Arc<[u8]> = Arc::from([1u8; 6].as_slice());
    let d2: Arc<[u8]> = Arc::from([2u8; 6].as_slice());
    let d3: Arc<[u8]> = Arc::from([3u8; 6].as_slice());

    cache.insert(k1.clone(), Arc::clone(&d1));
    cache.insert(k2.clone(), Arc::clone(&d2));

    // Touch k1 so k2 becomes LRU; inserting k3 evicts k2.
    let hit = cache.get(&k1).expect("k1 hit");
    assert!(Arc::ptr_eq(&hit, &d1));

    cache.insert(k3.clone(), Arc::clone(&d3));
    assert!(cache.get(&k1).is_some());
    assert!(cache.get(&k2).is_none());
    assert!(cache.get(&k3).is_some());

    // Archive invalidation removes only a.cbz entries and preserves b.cbz.
    cache.invalidate_archive("a.cbz");
    assert!(cache.get(&k1).is_none());
    assert!(cache.get(&k3).is_some());

    // Clear removes everything.
    cache.clear();
    assert!(cache.get(&k3).is_none());

    // Global cache invalidation hooks roundtrip.
    let global_a = TiffCacheKey::Archive {
        archive_path: "global-a.cbz".to_string(),
        entry_name: "p.tif".to_string(),
    };
    let global_b = TiffCacheKey::Archive {
        archive_path: "global-b.cbz".to_string(),
        entry_name: "p.tif".to_string(),
    };
    insert_cached_tiff_png(global_a.clone(), Arc::from([9u8; 4].as_slice()));
    insert_cached_tiff_png(global_b.clone(), Arc::from([8u8; 4].as_slice()));
    invalidate_tiff_cache_for_archive("global-a.cbz");
    assert!(get_cached_tiff_png(&global_a).is_none());
    assert!(get_cached_tiff_png(&global_b).is_some());
    clear_tiff_cache();
    assert!(get_cached_tiff_png(&global_b).is_none());
}

#[test]
fn serve_local_tiff_caches_valid_file_and_returns_404_for_missing_or_corrupt() {
    let dir = std::env::temp_dir().join(format!(
        "quivit-protocol-tiff-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let valid_path = dir.join("valid.tif");
    let corrupt_path = dir.join("corrupt.tif");
    let missing_path = dir.join("missing.tif");

    let mut tiff_bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::new(2, 2))
        .write_to(
            &mut std::io::Cursor::new(&mut tiff_bytes),
            image::ImageFormat::Tiff,
        )
        .expect("encode test TIFF");
    std::fs::write(&valid_path, &tiff_bytes).expect("write valid tiff");
    std::fs::write(&corrupt_path, b"not-a-tiff").expect("write corrupt tiff");

    let valid_str = valid_path.to_string_lossy().into_owned();
    let first = serve_local_tiff(&valid_str);
    assert_eq!(first.status(), 200);
    assert_eq!(first.headers()["Content-Type"], "image/png");
    assert_eq!(first.headers()["Cache-Control"], "no-store");
    assert_eq!(first.headers()["Access-Control-Allow-Origin"], "*");
    assert!(first.body().starts_with(b"\x89PNG\r\n\x1a\n"));

    let second = serve_local_tiff(&valid_str);
    assert_eq!(second.status(), 200);
    assert_eq!(second.body(), first.body());

    assert_eq!(serve_local_tiff(&corrupt_path.to_string_lossy()).status(), 404);
    assert_eq!(serve_local_tiff(&missing_path.to_string_lossy()).status(), 404);

    let err = error_response(400, b"Bad request");
    assert_eq!(err.status(), 400);
    assert_eq!(err.body(), b"Bad request");

    clear_tiff_cache();
    let _ = std::fs::remove_dir_all(&dir);
}
