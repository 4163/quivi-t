/**
 * viewerPipelineProbe.js: In-browser probe for viewer image pool lifecycles,
 * video pool lifecycles, active/bridge transitions, WebGL texture preparation,
 * and render race detection.
 */

export function createViewerPipelineProbe() {
  let isInitialized = false;
  let observer = null;
  let hadVisibleContentAtStart = false;
  let hasRenderedContent = false;

  function isContentVisible() {
    const imgWrapper = document.getElementById('viewer-img-wrapper');
    const activeImg = imgWrapper?.querySelector('.viewer-img.active');
    const bridgeImg = document.getElementById('viewer-bridge-layer')?.querySelector('.viewer-img.bridge') ?? imgWrapper?.querySelector('.viewer-img.bridge');
    const activeVideo = imgWrapper?.querySelector('.viewer-video.active');
    const bridgeVideo = document.getElementById('viewer-bridge-layer')?.querySelector('.viewer-video.bridge') ?? imgWrapper?.querySelector('.viewer-video.bridge');
    const lanczosCanvas = document.getElementById('viewer-lanczos-canvas');
    const filterCanvas = document.getElementById('viewer-filter-canvas');

    const activeOpacity = activeImg ? parseFloat(window.getComputedStyle(activeImg).opacity) : 0;
    const bridgeOpacity = bridgeImg ? parseFloat(window.getComputedStyle(bridgeImg).opacity) : 0;
    const activeVideoOpacity = activeVideo ? parseFloat(window.getComputedStyle(activeVideo).opacity) : 0;
    const bridgeVideoOpacity = bridgeVideo ? parseFloat(window.getComputedStyle(bridgeVideo).opacity) : 0;
    const lanczosOpacity = lanczosCanvas ? parseFloat(window.getComputedStyle(lanczosCanvas).opacity) : 0;
    const filterOpacity = filterCanvas ? parseFloat(window.getComputedStyle(filterCanvas).opacity) : 0;

    const lanczosReady = lanczosCanvas?.getAttribute('data-render-ready') === 'true';
    const filterReady = filterCanvas?.getAttribute('data-render-ready') === 'true';

    const hasActive = !!(activeImg && activeOpacity > 0 && activeImg.complete && activeImg.naturalWidth > 0);
    const hasBridge = !!(bridgeImg && bridgeOpacity > 0 && bridgeImg.naturalWidth > 0);
    const hasActiveVideo = !!(activeVideo && activeVideoOpacity > 0 && activeVideo.readyState >= 2 && activeVideo.videoWidth > 0);
    const hasBridgeVideo = !!(bridgeVideo && bridgeVideoOpacity > 0 && bridgeVideo.readyState >= 2);
    const hasCanvas = (lanczosReady && lanczosOpacity > 0) || (filterReady && filterOpacity > 0);

    return hasActive || hasBridge || hasActiveVideo || hasBridgeVideo || hasCanvas;
  }

  function ensureInitialized() {
    if (isInitialized) return;
    isInitialized = true;

    const diag = window.__QUIVIT_DIAGNOSTICS__;
    if (!diag) return;

    // 1. Wrap HTMLImageElement.prototype.decode for decode timeline
    if (typeof HTMLImageElement !== 'undefined' && HTMLImageElement.prototype.decode) {
      const originalDecode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function() {
        const isViewerImg = this.classList.contains('viewer-img');
        if (!isViewerImg) return originalDecode.call(this);

        const src = this.getAttribute('src') || this.src || '';
        const startTime = performance.now();
        diag.recordEvent('viewer', 'image-decode-start', { src });

        try {
          const res = await originalDecode.call(this);
          const elapsedMs = parseFloat((performance.now() - startTime).toFixed(2));
          diag.recordEvent('viewer', 'image-decode-end', {
            src,
            elapsedMs,
            naturalWidth: this.naturalWidth,
            naturalHeight: this.naturalHeight,
          });
          return res;
        } catch (err) {
          const elapsedMs = parseFloat((performance.now() - startTime).toFixed(2));
          diag.recordEvent('viewer', 'image-decode-fail', {
            src,
            elapsedMs,
            error: String(err),
          });
          throw err;
        }
      };
    }

    // 2. Wrap window.createImageBitmap for WebGL texture upload preparation
    if (typeof window.createImageBitmap === 'function') {
      const originalCreateImageBitmap = window.createImageBitmap;
      window.createImageBitmap = async function(...args) {
        const startTime = performance.now();
        try {
          const bitmap = await originalCreateImageBitmap.apply(this, args);
          const elapsedMs = parseFloat((performance.now() - startTime).toFixed(2));
          diag.recordEvent('viewer', 'bitmap-create-end', {
            elapsedMs,
            width: bitmap.width,
            height: bitmap.height,
          });
          return bitmap;
        } catch (err) {
          const elapsedMs = parseFloat((performance.now() - startTime).toFixed(2));
          diag.recordEvent('viewer', 'bitmap-create-fail', {
            elapsedMs,
            error: String(err),
          });
          throw err;
        }
      };
    }

    // 3. MutationObserver for microtask-level class and attribute changes
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes') {
            if (m.attributeName === 'class' && m.target.classList.contains('viewer-img')) {
              const isActive = m.target.classList.contains('active');
              const isBridge = m.target.classList.contains('bridge');
              const role = isActive ? 'active' : (isBridge ? 'bridge' : 'idle');
              diag.recordEvent('viewer', 'img-role-change', {
                role,
                src: m.target.getAttribute('src') || m.target.src || null,
              });
            } else if (m.attributeName === 'class' && m.target.classList.contains('viewer-video')) {
              const isActive = m.target.classList.contains('active');
              const isBridge = m.target.classList.contains('bridge');
              const role = isActive ? 'active' : (isBridge ? 'bridge' : 'idle');
              diag.recordEvent('viewer', 'video-role-change', {
                role,
                src: m.target.dataset?.vidSrc || m.target.getAttribute('src') || m.target.src || null,
              });
            } else if (m.attributeName === 'data-render-ready') {
              const ready = m.target.getAttribute('data-render-ready') === 'true';
              diag.recordEvent('viewer', 'canvas-ready-change', {
                canvasId: m.target.id,
                ready,
              });
            } else if (m.attributeName === 'data-filter' && m.target.id === 'viewport') {
              diag.recordEvent('viewer', 'viewport-filter-change', {
                filter: m.target.getAttribute('data-filter'),
              });
            }
          }
        }
      });

      const viewport = document.getElementById('viewport');
      if (viewport) {
        observer.observe(viewport, {
          attributes: true,
          subtree: true,
          attributeFilter: ['class', 'data-render-ready', 'data-filter'],
        });
      }
    }
  }

  return {
    onStepStart(step) {
      ensureInitialized();
      hadVisibleContentAtStart = isContentVisible();
      hasRenderedContent = hadVisibleContentAtStart;
    },
    checkFrame(frameCtx) {
      const statusbarFilename = document.querySelector('#statusbar .status-filename, #statusbar .filename')?.textContent?.trim() || '';
      if (statusbarFilename === '..' || statusbarFilename.endsWith('/') || statusbarFilename.endsWith('\\')) {
        return null;
      }

      const isVisible = isContentVisible();
      if (isVisible) {
        hasRenderedContent = true;
      }

      const isBlackout = !isVisible && (hadVisibleContentAtStart || hasRenderedContent);
      if (!isBlackout) return null;

      const imgWrapper = document.getElementById('viewer-img-wrapper');
      const activeImg = imgWrapper?.querySelector('.viewer-img.active');
      const bridgeImg = document.getElementById('viewer-bridge-layer')?.querySelector('.viewer-img.bridge') ?? imgWrapper?.querySelector('.viewer-img.bridge');
      const activeVideo = imgWrapper?.querySelector('.viewer-video.active');
      const bridgeVideo = document.getElementById('viewer-bridge-layer')?.querySelector('.viewer-video.bridge') ?? imgWrapper?.querySelector('.viewer-video.bridge');
      const lanczosCanvas = document.getElementById('viewer-lanczos-canvas');
      const filterCanvas = document.getElementById('viewer-filter-canvas');

      return {
        type: 'blackout',
        t: frameCtx.relMs,
        activeSrc: activeImg?.getAttribute('src') || activeImg?.src || null,
        activeComplete: activeImg?.complete || false,
        activeNaturalWidth: activeImg?.naturalWidth || 0,
        activeOpacity: activeImg ? parseFloat(window.getComputedStyle(activeImg).opacity) : 0,
        bridgeSrc: bridgeImg?.getAttribute('src') || bridgeImg?.src || null,
        bridgeOpacity: bridgeImg ? parseFloat(window.getComputedStyle(bridgeImg).opacity) : 0,
        activeVideoSrc: activeVideo?.dataset?.vidSrc || activeVideo?.getAttribute('src') || activeVideo?.src || null,
        activeVideoReadyState: activeVideo?.readyState || 0,
        activeVideoOpacity: activeVideo ? parseFloat(window.getComputedStyle(activeVideo).opacity) : 0,
        bridgeVideoSrc: bridgeVideo?.dataset?.vidSrc || bridgeVideo?.getAttribute('src') || bridgeVideo?.src || null,
        bridgeVideoOpacity: bridgeVideo ? parseFloat(window.getComputedStyle(bridgeVideo).opacity) : 0,
        lanczosReady: lanczosCanvas?.getAttribute('data-render-ready') === 'true',
        lanczosOpacity: lanczosCanvas ? parseFloat(window.getComputedStyle(lanczosCanvas).opacity) : 0,
        filterReady: filterCanvas?.getAttribute('data-render-ready') === 'true',
        filterOpacity: filterCanvas ? parseFloat(window.getComputedStyle(filterCanvas).opacity) : 0,
      };
    },
  };
}
