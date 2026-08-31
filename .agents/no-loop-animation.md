# No-loop WebP, APNG, and AVIF

Work report for the next slice. Animated AVIF now takes the same filter/Lanczos pump as WebP and APNG. This file is only about finite repeats: play once (or N times), then hold the last frame.

GIF already does this. The other three formats can express the same idea and we ignore them.

## Why this exists

Native `<img>` honors loop metadata. The WebCodecs pump does not. `ImageDecoder` gives you frames and durations. It does not tell you whether to wrap. The pump wraps unless `Core.noLoop` is true:

```
src/js/viewer/viewerPipelines.js  (pumpTick)
  if last frame and !live.noLoop -> frameIndex = 0
  else break  (hold last frame)
```

`noLoop` comes from `check_is_animated` -> `formats.rs` `AnimationInfo.no_loop`. Today only `check_gif` ever sets it. WebP, APNG, and AVIF always return `no_loop: false`.

So a play-once WebP looks correct with Pixelated/Bilinear, then loops forever the moment you turn on CRT or Lanczos. Same bug GIF used to have. Same fix.

`core.js` still comments this as "specifically a no-loop animated GIF". That comment is the leftover, not a rule.

## What each format actually stores

The pump only has a boolean. It cannot play "exactly 3 times" today. GIF already collapses every finite count into `no_loop = true` (stop on the last frame after one pass). Do the same for the other three unless you deliberately upgrade the pump to a remaining-plays counter. Matching native `<img>` for WebP/APNG would need that counter. I would not start there. Ship the boolean first. It matches GIF, and it fixes the freeze-vs-loop mismatch people will actually notice.

**GIF (done).** `NETSCAPE2.0` loop count, u16 LE.
- Missing block: play once. `no_loop = true`.
- `0`: infinite. `no_loop = false`.
- `1+`: finite. `no_loop = true`.
- Fixture: `test-files/no_loop.gif`.

**WebP (not done).** `ANIM` chunk after `VP8X`.
- Layout after the `ANIM` FourCC and chunk size: background color (u32 LE), then `loop_count` (u16 LE).
- `0` = infinite. `N > 0` = play N times in libwebp / Chromium.
- Detection today only reads the VP8X ANIM bit (`formats.rs` `check_webp`). It never opens `ANIM`.

**APNG (not done).** `acTL` chunk, 8-byte payload.
- `num_frames` u32 BE, then `num_plays` u32 BE.
- `0` = infinite. `N > 0` = play N times.
- Detection today only checks that `acTL` appears before `IDAT`. It ignores `num_plays`.

**AVIF sequence (not done).** No GIF-style integer. libavif writes `repetitionCount` into the track `elst` (edit list) under `moov/trak/edts`.
- libavif `0` = play once. This is the opposite of GIF/WebP/APNG, where `0` is infinite.
- Infinite is a sentinel (`AVIF_REPETITION_COUNT_INFINITE`), usually a max u32, encoded as a special `elst` duration.
- No `elst` at all: the file does not say. Browsers loop. Our current sequence fixture (`test-files/export_1788174887667.avif`) has `moov` and no `elst`. Leave `no_loop = false` for that case.
- Do not treat "has `moov`" as play-once.

## What not to touch

- Do not change the still-image GPU path.
- Do not add a second pump. The existing `noLoop` branch is the behavior.
- Do not parse loop metadata out of `mdat` / compressed frames. Header boxes and chunks only, same 256 KiB cap `check_is_animated` already uses.
- Do not walk `elst` with a `windows(4)` search for the letters `elst`. Walk ISO BMFF boxes like `check_avif` already does.
- `avio` (AVIF image collection) is not an animation. Leave it still.

## Suggested slices

### Slice 1. Parsers

`src-tauri/src/formats.rs`

- `check_webp`: keep the VP8X ANIM bit for `is_animated`. If animated, find the `ANIM` chunk and set `no_loop = loop_count != 0`. Missing `ANIM` on an ANIM-flagged file: treat as infinite (`no_loop = false`). That matches "we don't know, don't freeze."
- `check_apng`: after confirming `acTL` before `IDAT`, read the 8 bytes after the `acTL` type. `no_loop = num_plays != 0`. Truncated payload: `no_loop = false`.
- `check_avif`: return `AnimationInfo`, not `bool`. `is_animated` stays `avis` brand or AVIF-family `moov` (already shipped). `no_loop` is true only when an `elst` clearly says play once. No `elst`: `no_loop = false`. Finite-but-not-once can wait. Map it to `no_loop = true` if you want GIF parity and you can tell it is finite. If the encoding is ambiguous, leave it looping.

`check_animation_status` already returns `AnimationInfo`. JS already writes `state.noLoop`. No IPC shape change.

### Slice 2. Tests

`src-tauri/src/tests/format_tests.rs`, same style as `test_is_animated_gif_no_loop`.

Synthetic buffers are enough for the scanners:

- WebP: VP8X ANIM bit plus an `ANIM` chunk with `loop_count` 0 and 1.
- APNG: `acTL` with `num_plays` 0 and 1, still before `IDAT`.
- AVIF: `ftyp avis` with no `elst` (loop). A tiny `moov/trak/edts/elst` that means play once, if you can build one by hand. Skip a real encoder until you have a fixture.

Run `cargo test format_tests`. Existing GIF no-loop test must stay green.

### Slice 3. Fixtures and a look at the running app

We only have `test-files/no_loop.gif`. You will want one play-once file per format in `test-files/`, then drop copies into the eight main archives the way the animated AVIF was added.

Manual check, per file:

1. Open with Pixelated. It should play once and hold.
2. Turn on CRT. It should still play once and hold, not wrap.
3. Turn CRT off. Native playback should still be stopped on the last frame, not restart.

If step 1 loops, the file is not a play-once sample. If step 1 holds and step 2 wraps, the parser missed `no_loop`.

## Open choice, make it before slice 1

Keep GIF's boolean (any finite count = stop after one pass), or teach the pump a remaining-plays integer so "play 3 times" matches native `<img>`.

I would keep the boolean. The pump already has it. GIF already uses it. Play-N is a real feature and a bigger change (`no_loop` would have to become `loop_count`, including `0 = infinite` vs AVIF's `0 = once`). Do not mix those encodings in one field without a documented mapping.

## Files

| Path | Role |
|---|---|
| `src-tauri/src/formats.rs` | Parsers. Only writer of `no_loop` besides the GIF path. |
| `src-tauri/src/models.rs` | `AnimationInfo { is_animated, no_loop }`. Keep as-is for the boolean plan. |
| `src-tauri/src/commands/animation.rs` | Pass-through. No change. |
| `src/js/core.js` | Stores `noLoop`. Update the GIF-only comment when this ships. |
| `src/js/viewer/viewerPipelines.js` | Already honors `noLoop`. No change for the boolean plan. |
| `src-tauri/src/tests/format_tests.rs` | New cases. |
| `test-files/no_loop.gif` | Existing GIF fixture. |
