#[cfg(windows)]
mod windows_tests {
    use super::super::*;
    use std::sync::Mutex;

    static CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn cached_native_icon_png_returns_valid_png_and_hits_cache() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cached_native_icons().expect("clear icon cache");

        let small = get_cached_native_icon_png_with_size("", "png", IconSize::Small)
            .expect("small icon lookup")
            .expect("small png icon bytes");
        assert!(small.starts_with(b"\x89PNG\r\n\x1a\n"));

        let small_hit = get_cached_native_icon_png_with_size("", "png", IconSize::Small)
            .expect("small icon cache hit")
            .expect("cached small png icon bytes");
        assert_eq!(small, small_hit);

        let large = get_cached_native_icon_png_with_size("", "png", IconSize::Large)
            .expect("large icon lookup")
            .expect("large png icon bytes");
        assert!(large.starts_with(b"\x89PNG\r\n\x1a\n"));

        let large_hit = get_cached_native_icon_png_with_size("", "png", IconSize::Large)
            .expect("large icon cache hit")
            .expect("cached large png icon bytes");
        assert_eq!(large, large_hit);
    }

    #[test]
    fn get_cached_native_icon_returns_data_urls_for_all_size_variants() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cached_native_icons().expect("clear icon cache");

        for size in [None, Some("large"), Some("32")] {
            let url = get_cached_native_icon("", "png", size)
                .expect("data url lookup")
                .expect("expected data url");
            assert!(
                url.starts_with("data:image/png;base64,"),
                "unexpected data url prefix for size {size:?}"
            );
        }
    }

    #[test]
    fn clear_cached_native_icons_empties_cache() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _ = get_cached_native_icon_png_with_size("", "png", IconSize::Small)
            .expect("populate icon cache");

        clear_cached_native_icons().expect("clear icon cache");

        let guard = NATIVE_ICON_CACHE.lock().expect("lock icon cache");
        if let Some(map) = guard.as_ref() {
            assert!(map.is_empty(), "expected cache to be empty after clear");
        }
    }

    #[test]
    fn cache_keys_fold_ascii_case_and_try_get_hits_without_blocking() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cached_native_icons().expect("clear icon cache");

        assert!(try_get_cached_native_icon_png_with_size("png", IconSize::Small).is_none());

        let lower = get_cached_native_icon_png_with_size("", "png", IconSize::Small)
            .expect("lowercase png icon")
            .expect("png icon bytes");

        let upper_fast = try_get_cached_native_icon_png_with_size("PNG", IconSize::Small)
            .expect("uppercase key should hit lowercase cache entry");
        assert_eq!(&*upper_fast, lower.as_slice());

        let upper = get_cached_native_icon_png_with_size("", "PNG", IconSize::Small)
            .expect("uppercase png icon")
            .expect("cached png icon bytes");
        assert_eq!(upper, lower);

        let guard = NATIVE_ICON_CACHE.lock().expect("lock icon cache");
        assert_eq!(guard.as_ref().map(|c| c.len()), Some(1));
    }

    #[test]
    fn cache_enforces_max_native_icon_cache_entries_cap() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_cached_native_icons().expect("clear icon cache");

        {
            let mut guard = NATIVE_ICON_CACHE.lock().expect("lock icon cache");
            let cache = guard.get_or_insert_with(NativeIconCache::new);
            for i in 0..(MAX_NATIVE_ICON_CACHE_ENTRIES + 64) {
                cache.insert(format!("synthetic-{i}"), Arc::from(&[1u8, 2, 3, 4][..]));
            }
            assert_eq!(cache.len(), MAX_NATIVE_ICON_CACHE_ENTRIES);
        }

        // Oldest synthetic entries were evicted; newest remain reachable via try_get.
        assert!(try_get_cached_native_icon_png_with_size("synthetic-0", IconSize::Small).is_none());
        let newest_key = format!("synthetic-{}", MAX_NATIVE_ICON_CACHE_ENTRIES + 63);
        let newest = try_get_cached_native_icon_png_with_size(&newest_key, IconSize::Small)
            .expect("newest entry should still be cached");
        assert_eq!(&*newest, &[1u8, 2, 3, 4]);

        clear_cached_native_icons().expect("clear icon cache");
    }
}
