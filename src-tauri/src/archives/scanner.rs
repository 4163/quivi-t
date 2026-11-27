use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use crate::formats;
use crate::models::DimensionEntry;

use super::cache::{archive_entry_temp_path, ArchiveCache, ExtractNotify};
use super::encoding::decode_cjk_name;
use super::zip::open_zip_archive;
use super::ArchiveKind;

pub(crate) const DIMS_BATCH_SIZE: usize = 64;
pub(crate) const TEMP_REG_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Extensions skipped during the width scan. SVG has no reliable header
/// dimensions, and ICO header dimensions differ from the generated row total.
pub(crate) fn skip_for_width_scan(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("svg") || ext.eq_ignore_ascii_case("ico")
}

fn should_scan_ext(ext: &str, skip_svg_ico: bool) -> bool {
    if skip_svg_ico && skip_for_width_scan(ext) {
        return false;
    }
    formats::is_image_ext(ext) || ext.eq_ignore_ascii_case("mp4")
}

fn wait_for_temp_extraction_state(
    cache: Option<&RwLock<ArchiveCache>>,
    archive_path: &str,
    timeout: Duration,
    is_cancelled: &impl Fn() -> bool,
) -> Option<(PathBuf, ExtractNotify)> {
    let cache = cache?;
    let reg_notify = {
        let guard = cache.read().ok()?;
        if let Some(state) = guard.temp_extraction_state(archive_path) {
            return Some(state);
        }
        guard.temp_reg_notify()
    };

    let (lock, cvar) = &*reg_notify;
    let start = Instant::now();
    let mut last_seq = *lock.lock().unwrap_or_else(|p| p.into_inner());

    loop {
        if is_cancelled() {
            return None;
        }
        if let Ok(guard) = cache.read() {
            if let Some(state) = guard.temp_extraction_state(archive_path) {
                return Some(state);
            }
        }
        let elapsed = start.elapsed();
        if elapsed >= timeout {
            return None;
        }
        let wait_for = (timeout - elapsed).min(Duration::from_millis(50));
        let mut seq_guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        if *seq_guard == last_seq {
            let (next_guard, _) = cvar
                .wait_timeout(seq_guard, wait_for)
                .unwrap_or_else(|p| p.into_inner());
            seq_guard = next_guard;
        }
        last_seq = *seq_guard;
    }
}

fn scan_directory_entries(
    dir: &str,
    skip_svg_ico: bool,
    is_cancelled: &impl Fn() -> bool,
    on_entry: &mut impl FnMut(DimensionEntry),
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if is_cancelled() {
            return;
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !should_scan_ext(ext, skip_svg_ico) {
            continue;
        }
        let Some(name) = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
        else {
            continue;
        };
        if let Some((width, height)) = formats::read_media_dimensions_from_path(&path, ext) {
            on_entry(DimensionEntry {
                name,
                width,
                height,
            });
        }
    }
}

fn scan_zip_entries(
    archive_path: &str,
    password: Option<&str>,
    skip_svg_ico: bool,
    is_cancelled: &impl Fn() -> bool,
    on_entry: &mut impl FnMut(DimensionEntry),
) {
    let Ok(mut archive) = open_zip_archive(archive_path) else {
        return;
    };
    let count = archive.len();
    for i in 0..count {
        if is_cancelled() {
            return;
        }
        let mut entry = match password {
            Some(pwd) => archive.by_index_decrypt(i, pwd.as_bytes()),
            None => archive.by_index(i),
        };
        let Ok(entry) = entry.as_mut() else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let name = decode_cjk_name(entry.name_raw());
        let ext = name.rsplit('.').next().unwrap_or("");
        if !should_scan_ext(ext, skip_svg_ico) {
            continue;
        }
        let entry_size = entry.size();
        if let Some((width, height)) =
            formats::read_media_dimensions_from_stream(entry, entry_size, ext)
        {
            on_entry(DimensionEntry {
                name,
                width,
                height,
            });
        }
    }
}

enum ScanEvent {
    Entry(DimensionEntry),
    BatchBoundary,
}

fn scan_temp_archive_entries(
    archive_path: &str,
    cache: Option<&RwLock<ArchiveCache>>,
    skip_svg_ico: bool,
    temp_reg_timeout: Duration,
    is_cancelled: &impl Fn() -> bool,
    on_event: &mut impl FnMut(ScanEvent),
) {
    let Some((temp_dir, notify)) =
        wait_for_temp_extraction_state(cache, archive_path, temp_reg_timeout, is_cancelled)
    else {
        return;
    };

    let (lock, cvar) = &*notify;
    let mut cursor: usize = 0;

    loop {
        if is_cancelled() {
            return;
        }

        let (to_check, is_finished) = {
            let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
            let new_entries = guard.extracted_order[cursor..].to_vec();
            cursor = guard.extracted_order.len();
            (new_entries, guard.finished)
        };

        for name in to_check {
            if is_cancelled() {
                return;
            }
            let ext = name.rsplit('.').next().unwrap_or("");
            if !should_scan_ext(ext, skip_svg_ico) {
                continue;
            }
            if let Some(path) = archive_entry_temp_path(&temp_dir, &name) {
                if let Some((width, height)) = formats::read_media_dimensions_from_path(&path, ext)
                {
                    on_event(ScanEvent::Entry(DimensionEntry {
                        name,
                        width,
                        height,
                    }));
                }
            }
        }

        on_event(ScanEvent::BatchBoundary);

        if is_finished {
            break;
        }

        let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        if !guard.finished && guard.extracted_order.len() == cursor {
            let _ = cvar.wait_timeout(guard, Duration::from_millis(50));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn scan_container_entries(
    container: &str,
    is_archive: bool,
    password: Option<&str>,
    cache: Option<&RwLock<ArchiveCache>>,
    skip_svg_ico: bool,
    temp_reg_timeout: Duration,
    is_cancelled: &impl Fn() -> bool,
    on_event: &mut impl FnMut(ScanEvent),
) {
    if !is_archive {
        scan_directory_entries(container, skip_svg_ico, is_cancelled, &mut |entry| {
            on_event(ScanEvent::Entry(entry));
        });
    } else if matches!(ArchiveKind::from_path(container), Ok(ArchiveKind::Zip)) {
        scan_zip_entries(
            container,
            password,
            skip_svg_ico,
            is_cancelled,
            &mut |entry| {
                on_event(ScanEvent::Entry(entry));
            },
        );
    } else {
        scan_temp_archive_entries(
            container,
            cache,
            skip_svg_ico,
            temp_reg_timeout,
            is_cancelled,
            on_event,
        );
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn scan_container_max_width_with(
    container: &str,
    is_archive: bool,
    password: Option<&str>,
    cache: Option<&RwLock<ArchiveCache>>,
    temp_reg_timeout: Duration,
    is_cancelled: impl Fn() -> bool,
    mut on_progress: impl FnMut(u32),
    mut on_done: impl FnMut(u32),
) {
    let mut max_w: u32 = 0;
    let mut on_event = |event: ScanEvent| {
        if let ScanEvent::Entry(entry) = event {
            if entry.width > max_w {
                max_w = entry.width;
                on_progress(max_w);
            }
        }
    };

    scan_container_entries(
        container,
        is_archive,
        password,
        cache,
        true,
        temp_reg_timeout,
        &is_cancelled,
        &mut on_event,
    );

    if !is_cancelled() {
        on_done(max_w);
    }
}

pub(crate) fn scan_container_dimensions_with(
    container: &str,
    is_archive: bool,
    password: Option<&str>,
    cache: Option<&RwLock<ArchiveCache>>,
    temp_reg_timeout: Duration,
    is_cancelled: impl Fn() -> bool,
    mut on_batch: impl FnMut(Vec<DimensionEntry>, bool),
) {
    let mut batch = Vec::with_capacity(DIMS_BATCH_SIZE);
    let mut on_event = |event: ScanEvent| match event {
        ScanEvent::Entry(entry) => {
            if entry.width > 0 && entry.height > 0 {
                batch.push(entry);
                if batch.len() >= DIMS_BATCH_SIZE && !is_cancelled() {
                    on_batch(std::mem::take(&mut batch), false);
                }
            }
        }
        ScanEvent::BatchBoundary => {
            if !batch.is_empty() && !is_cancelled() {
                on_batch(std::mem::take(&mut batch), false);
            }
        }
    };

    scan_container_entries(
        container,
        is_archive,
        password,
        cache,
        false,
        temp_reg_timeout,
        &is_cancelled,
        &mut on_event,
    );

    if !is_cancelled() {
        on_batch(batch, true);
    }
}
