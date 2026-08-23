# Scaling & Filter Research for QuiviT

Research on scaling methods worth adding to the experimental pipeline. Focused on manga panels and anime illustrations, plus fun visual filters.

## Serious scaling methods

### Anime4K (edge-directed sharpening + CNN upscale)

The most practical candidate. It treats image luminance as a heightmap and "pushes" pixels toward detected edges via gradient ascent. The result is sharper line art without the blurriness of bilinear/bicubic, and without the latency of full neural-network inference.

**Why it fits QuiviT:**
- Runs as GLSL fragment shaders, so it works with our existing WebGL canvas pipeline
- Real-time at 1080p→4K on modest GPUs. For still images it would be near-instant
- Specifically tuned for flat color blocks and sharp outlines (anime/manga)
- Multi-pass pipeline: denoise → upscale → refine. We could expose individual passes as toggles
- JS implementation exists: [monyone/Anime4K.js](https://github.com/monyone/Anime4K.js) (WebGL2, v4.0.1 shaders)
- WebGPU version also exists on npm (`anime4k-webgpu`), and WebView2 supports WebGPU now

**Tradeoff:** It amplifies compression artifacts if the source is a low-quality JPEG. The denoise pass helps, but it's not magic.

**Verdict:** Worth adding. The WebGL2 path means we can integrate it alongside the existing Pica pipeline without new dependencies beyond the shader source. It would sit as a fourth scaling mode: `Scaling: Anime4K`.

---

### Real-ESRGAN / Real-CUGAN (neural network super-resolution)

The "gold standard" for anime upscaling quality. Real-ESRGAN Anime-6B is specifically trained on line art and cel-shading. Real-CUGAN sometimes produces more natural backgrounds.

**Why it's interesting:**
- Noticeably better quality than any shader-based method
- [web-realesrgan](https://github.com/xororz/web-realesrgan) runs it in-browser via TensorFlow.js (WebGL or WebGPU backend)

**Why it's risky for QuiviT:**
- Even with WebGPU, inference on a single 1080p image takes 2-10 seconds depending on GPU
- TensorFlow.js is a heavy dependency (~2-4 MB)
- Memory usage spikes hard during inference
- Not real-time. Would need an explicit "enhance" action rather than a live scaling mode

**Verdict:** Interesting as an explicit one-shot "Enhance Image" action (not a scaling mode). Deferred until after Anime4K ships, since it needs a different UX pattern.

---

### Waifu2x (the original anime upscaler)

The predecessor to Real-ESRGAN. Still effective for clean, simple upscaling. Lighter than Real-ESRGAN but lower quality ceiling.

**Verdict:** Superseded by Real-ESRGAN for quality and by Anime4K for speed. Skip unless someone specifically asks for it.

---

## Pixel art scaling methods (fun / niche)

These come from the emulation scene and are designed for low-res pixel art. They'd be novelty filters rather than production tools, but they're genuinely cool on the right content.

### xBR (rule-based edge interpolation)

Detects edges and interpolates along them. Produces smooth, rounded pixel art that looks hand-drawn at higher resolutions. Multi-pass, so it needs intermediate framebuffers, but the math is cheap.

**Best for:** Pixel art manga panels, game screenshots, low-res sprites.

### HQx (hq2x, hq3x, hq4x)

Compares a pixel's 8 neighbors using a lookup table to decide blending weights. Produces clean curves from jagged pixel edges. The LUT is passed as a secondary texture in the shader.

**Best for:** Retro game art, small icons, pixel-art-style illustrations.

### Scale2x (EPX)

The simplest of the three. A 3×3 neighborhood check that expands each pixel into a 2×2 block. Fast, preserves the original color palette, but rounds off sharp corners.

**Best for:** Quick doubling of tiny images without blur.

**Where to get shaders:** [libretro/glsl-shaders](https://github.com/libretro/glsl-shaders) has battle-tested GLSL for all three. We'd port the fragment shaders to our WebGL pipeline.

**Verdict:** Fun additions. Low effort to integrate since they're single-pass (or 2-pass for xBR). Could group them under a "Pixel Art" submenu or expose as experimental scaling modes.

---

## Fun visual filters

### CRT scanline filter

Simulates a curved CRT monitor with scanlines, barrel distortion, phosphor glow, chromatic aberration, and vignette. Multiple WebGL libraries exist:
- [crt-fx](https://github.com/stefanlegg/crt-fx) (npm, lightweight)
- [RetroZone](https://github.com/TheMarco/RetroZone) (engine-agnostic, works with plain Canvas2D)

The effect is layered from several fragment shader techniques, all cheap to run. Would look great as a toggle for retro manga or pixel art viewing.

**Verdict:** Low-effort, high-fun. A single post-processing shader pass on the final canvas output would do it.

---

## Integration plan (rough priority)

| Priority | Method | Type | Effort | Notes |
|:---------|:-------|:-----|:-------|:------|
| [x] 1 | **Anime4K** | Serious | Medium | WebGL2 shaders, real-time, purpose-built for anime |
| [x] 2 | **CRT filter** | Fun | Low | Single post-process pass, instant wow factor |
| [ ] 3 | **xBR / HQx** | Niche | Low-Medium | Pixel art upscaling from libretro shaders |
| [ ] 4 | **Real-ESRGAN** | Serious | High | Neural net, needs explicit "enhance" UX, heavy deps |

All of these would use WebGL (or WebGPU where available) on the existing canvas element. The Pica/Lanczos CPU pipeline stays as the baseline. GPU methods layer on top as post-processing.
