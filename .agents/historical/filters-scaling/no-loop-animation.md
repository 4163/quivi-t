# Exact Loop Counts for Animations (WebP, APNG, AVIF, GIF)

Animated AVIF takes the same filter/Lanczos pump as WebP and APNG. This file describes the exact finite loop count support for all animated formats: play exactly N times, then hold the last frame.

## Why this exists

Native `<img>` honors loop metadata. The WebCodecs pump previously had no loop-count awareness. `ImageDecoder` gives frames and durations but not whether to wrap. The pump wrapped unconditionally unless `Core.noLoop` was true, and `noLoop` was a boolean that only GIF ever set.

**The normalization problem:** Chromium handles loop counts differently across formats.
- GIF and WebP: a file's loop count of `X` means "play `X + 1` times total".
- APNG: a loop count of `X` means "play `X` times total".

Passing the raw integer to JS would desync the GPU pump from native `<img>`. Rust normalizes parsed values into a strict `total_plays` integer (`loop_count`) before IPC.
- `0` = infinite.
- `N` = play exactly `N` times total.

## What each format stores and how we normalize

**GIF.** `NETSCAPE2.0` loop count, u16 LE.
- Missing block: play once (`total_plays = 1`).
- `0`: infinite (`total_plays = 0`).
- `N > 0`: Chromium plays `N + 1` times. Return `total_plays = N + 1`.

**WebP.** `ANIM` chunk after `VP8X`. Layout: 4-byte background color, then u16 LE `loop_count` at offset +12 from the `ANIM` tag.
- `0`: infinite (`total_plays = 0`).
- `N > 0`: Chromium plays `N + 1` times. Return `total_plays = N + 1`.
- Missing `ANIM`: `total_plays = 0`.

**APNG.** `acTL` chunk, 8-byte payload: `num_frames` u32 BE, then `num_plays` u32 BE.
- `0`: infinite (`total_plays = 0`).
- `N > 0`: Chromium plays exactly `N` times. Return `total_plays = N`.
- Missing `acTL`: `total_plays = 0`.

**AVIF sequence.** libavif writes `repetitionCount` into the track `elst` (edit list). Parsing exact counts from the nested ISO BMFF `elst` payload is error-prone without a full parser.
- If an `elst` box is found inside `moov` (recursive walk through `moov/trak/edts`), conservatively return `total_plays = 1`.
- No `elst`: `total_plays = 0`.

## What not to touch

- Still-image GPU path.
- Do not parse loop metadata from `mdat` / compressed frames. Header boxes and chunks only, same 256 KiB cap `check_is_animated` already uses.
- Do not search for `elst` with `windows(4)`. Walk ISO BMFF boxes like `check_avif` already does.
- `avio` (AVIF image collection) is not an animation. Leave it still.

## Files

| Path | Role |
|---|---|
| `src-tauri/src/models.rs` | `AnimationInfo { is_animated, loop_count }`. |
| `src-tauri/src/formats.rs` | Parsers. Only writer of `loop_count`. Must normalize to `total_plays`. |
| `src-tauri/src/commands/animation.rs` | Pass-through. No change. |
| `src/js/core.js` | Stores `loopCount`. |
| `src/js/fsUtils.js` | Reads `loop_count` from IPC, passes to core. |
| `src/js/viewer/viewerPipelines.js` | Upgrade to enforce `loopCount` tracking. |
| `src-tauri/src/tests/format_tests.rs` | `loop_count` assertions for all four formats. |

## Test fixtures

| File | Format | Behavior |
|---|---|---|
| `test-files/gif/no_loop.gif` | GIF | Plays once (no `NETSCAPE2.0`) |
| `test-files/webp/export_loop1.webp` | WebP | Plays 2 times (`ANIM` loop_count=1, +1) |
| `test-files/apng/export_loop3.apng` | APNG | Plays 3 times (`acTL` num_plays=3) |
| `test-files/avif/export_loop1.avif` | AVIF | Plays 1 time (`elst` present) |
| `test-files/gif/still_single_frame.gif` | GIF | Still (not animated) |
| `test-files/webp/still_single_frame.webp` | WebP | Still (not animated) |
| `test-files/apng/still_single_frame.apng` | APNG | Still (not animated) |
| `test-files/avif/still_single_frame.avif` | AVIF | Still (not animated) |

Finite-loop fixtures were created by binary-patching the loop count bytes of existing animated files. The AVIF fixture had an `edts`/`elst` box injected into its first `trak` with all `stco` and `iloc` offsets corrected. Still fixtures are first-frame extracts from the animated sources.
