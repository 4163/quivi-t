<!--
Validation comparison against .agents/skills/validate-changes/SKILL.md performed.
-->

# Plan: Manhwa WebGL Zoom Flicker & Idle Render Loop Resolution

## Overview
Resolve visual slot flickering in manhwa mode under WebGL filters at 5% to 6% zoom and eliminate the continuous 60fps idle re-render loop caused by prefetch ping-pong eviction.

## Locked definitions
- **Pinned visible key**: A texture cache source key that corresponds to an actively rendered visible slot in the viewport. Such keys are exempt from LRU eviction during the composite pass.
- **Prefetch ping-pong loop**: The alternating cycle where forward and backward prefetch targets evict each other when prefetch cache capacity is smaller than the active prefetch targets count.

## Deviation rules
- Do not modify IPC contracts or Tauri commands in `src-tauri/`.
- Do not introduce DOM elements or styling inside pure services (`textureCache.js`).
- Preserve existing WebGL filter shaders and sampler contracts.

## Ordered checklist

### Slice 1: Visible Texture Pinning and Cache Sizing
- [x] In `src/js/services/pipelines/textureCache.js:68-150`:
  - Add `setPinnedKeys(keys)` to `TextureCache` to store active visible source keys (`Set<string>|null`).
  - In `TextureCache.put()`, update the LRU eviction loop to select the oldest key that is NOT in `_pinnedKeys`. If all keys are pinned, stop eviction.
  - Accept criteria: Visible textures are never deleted from VRAM while pinned, preventing blank slot holes and eviction thrash.
- [x] In `src/js/viewer/viewerPipelines.js:15`:
  - Retain `_columnTextureCache` budget at standard 128 MB (`128 * 1024 * 1024`).
  - Accept criteria: Pinning active visible keys guarantees on-screen slots are protected without expanding cache memory limits.
- [x] In `src/js/viewer/viewerPipelines.js:1898-1950`:
  - Before fetching missing textures and drawing quads, collect all visible sources into a `Set` and call `_columnTextureCache.setPinnedKeys(visibleKeys)`.
  - After drawing completes or on teardown, clear or unpin as appropriate.
  - Accept criteria: `_columnTextureCache.get(src)` reliably returns the texture for every visible slot during the quad draw loop.

### Slice 2: Prefetch Ping-Pong Elimination
- [x] In `src/js/viewer/manhwaStrip.js:37`:
  - Increase `PREFETCH_CACHE_CAPACITY` from `1` to `4` (providing safe capacity for `startIndex - 1` and `endIndex + 1` simultaneously).
  - Accept criteria: Neither forward nor backward prefetch targets evict each other in steady state; the prefetch cycle terminates upon loading both targets.
- [x] In `src/js/viewer/manhwaStrip.js:1240-1246`:
  - Increase `PREFETCH_CACHE_CAPACITY` to allow both directions to stay cached without thrashing layout.
  - Accept criteria: Idle steady state generates 0 layout or render requests.

### Slice 3: Verification and Telemetry Confirmation
- [x] Run unit tests: `npm run mocha` to verify core math and state contracts pass with 0 failures (305 passing, 0 failing).
- [x] Run replay scenario: `npm run diagnose -- manhwa-webgl-zoom-flicker` to confirm 0 blackout frames, 0 texture misses after initial load, and 0 idle renders.
