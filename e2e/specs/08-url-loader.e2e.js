import fs from 'fs';
import path from 'path';
import { expect } from 'expect-webdriverio';
import menubarPage from '../pageobjects/menubar.page.js';
import filepanelPage from '../pageobjects/filepanel.page.js';

const e2eLibraryRoot = path.resolve('src-tauri/target/debug/.e2e-localappdata/QuiviT/library');
const galleryPath = path.join(e2eLibraryRoot, 'E2E Gallery', 'Series', 'Chapter 01');

const manifest = JSON.stringify({
  version: 1,
  extractors: [{
    id: 'e2e-gallery',
    name: 'E2E Gallery',
    libraryPath: 'E2E Gallery',
    version: 1,
    patterns: ['^https://example\\.test/e2e-gallery$'],
    source: 'e2e-gallery.js'
  }]
});

const extractorSource = `
export function match(url) {
  return url === 'https://example.test/e2e-gallery';
}

export async function extract() {
  return {
    provider: 'E2E Gallery',
    title: 'Runtime-only gallery',
    gallery: {
      id: 'e2e-gallery-001',
      relativePath: ['Series', 'Chapter 01']
    },
    images: [
      { url: 'https://cdn.example.test/001.png', filename: '001.png' },
      { url: 'https://cdn.example.test/002.png', filename: '002.png' }
    ],
    nextPageUrl: null
  };
}
`;

function resetE2eLibrary() {
  const debugTarget = path.resolve('src-tauri/target/debug');
  if (!e2eLibraryRoot.startsWith(`${debugTarget}${path.sep}`)) {
    throw new Error('Refusing to clear an E2E library outside the debug target directory');
  }
  fs.rmSync(e2eLibraryRoot, { recursive: true, force: true });
}

describe('08 - URL gallery loader', () => {
  before(async () => {
    resetE2eLibrary();
    await menubarPage.ensureMainWindow();
    await browser.waitUntil(
      async () => await browser.execute(() => typeof window.__TAURI__?.core?.invoke === 'function'),
      { timeout: 8000, timeoutMsg: 'Tauri runtime was not ready' }
    );

    await browser.execute((testManifest, testExtractorSource) => {
      // Tauri freezes the invoke properties, so plain writes bounce
      // silently. Try every layer, verify, and fail loudly with the full
      // writability picture instead of timing out later.
      const mockFn = async (command, args, options) => {
        window.__quivitE2eFixtureCalls.push({ command, args });
        if (command === 'fetch_extractor_text') {
          if (args.relativePath === 'manifest.json') return testManifest;
          if (args.relativePath === 'e2e-gallery.js') return testExtractorSource;
        }
        if (command === 'fetch_text' && args.url === 'https://example.test/e2e-gallery') {
          return '<title>Runtime-only gallery</title>';
        }
        if (command === 'download_to_file') {
          return window.__quivitE2eOriginalInvoke('write_text_file', {
            path: args.destPath,
            content: 'e2e image data'
          });
        }
        // Fixture bytes are placeholders, not decodable images. The real
        // magic check would reject them, so it passes for fixture paths.
        if (command === 'verify_image_magic') {
          return undefined;
        }
        return window.__quivitE2eOriginalInvoke(command, args, options);
      };
      const core = window.__TAURI__?.core;
      const internals = window.__TAURI_INTERNALS__;
      const original = (core && core.invoke) || (internals && internals.invoke);
      if (typeof original !== 'function') {
        throw new Error('[08] no Tauri invoke found, cannot install fixture mock');
      }
      window.__quivitE2eOriginalInvoke = original.bind(core || internals);
      window.__quivitE2eFixtureCalls = [];
      try { if (core) core.invoke = mockFn; } catch {}
      try {
        if (core && String(core.invoke).indexOf('__quivitE2eFixtureCalls') === -1) {
          window.__TAURI__.core = { ...core, invoke: mockFn };
        }
      } catch {}
      try {
        if (internals && String(window.__TAURI__.core.invoke).indexOf('__quivitE2eFixtureCalls') === -1) {
          internals.invoke = mockFn;
        }
      } catch {}
      const live = window.__TAURI__?.core?.invoke;
      if (!live || String(live).indexOf('__quivitE2eFixtureCalls') === -1) {
        const desc = (o, k) => {
          try {
            const d = Object.getOwnPropertyDescriptor(o, k);
            return d ? `w=${!!d.writable},c=${!!d.configurable}` : 'missing';
          } catch { return 'unreadable'; }
        };
        throw new Error(
          '[08] fixture mock did not stick. ' +
          `TAURI_ext=${Object.isExtensible(window.__TAURI__)} ` +
          `core_ext=${core ? Object.isExtensible(core) : 'n/a'} ` +
          `core.invoke(${desc(core, 'invoke')}) ` +
          `internals.invoke(${desc(internals, 'invoke')})`
        );
      }
    }, manifest, extractorSource);
  });

  after(async () => {
    await browser.execute(() => {
      try {
        if (window.__quivitE2eOriginalInvoke) {
          const core = window.__TAURI__?.core;
          if (core) {
            try { core.invoke = window.__quivitE2eOriginalInvoke; } catch {}
            if (String(core.invoke).indexOf('__quivitE2eOriginalInvoke') === -1) {
              try { window.__TAURI__.core = { ...core, invoke: window.__quivitE2eOriginalInvoke }; } catch {}
            }
          }
          try {
            if (window.__TAURI_INTERNALS__) {
              window.__TAURI_INTERNALS__.invoke = window.__quivitE2eOriginalInvoke;
            }
          } catch {}
        }
      } finally {
        delete window.__quivitE2eOriginalInvoke;
        delete window.__quivitE2eFixtureCalls;
      }
    });
    resetE2eLibrary();
  });

  it('loads a manifest-only extractor and persists its nested gallery without an app rebuild', async () => {
    await menubarPage.openFileMenu();
    await $('#cmd-use-url').click();

    const urlInput = await $('#url-input');
    await urlInput.waitForDisplayed();
    await urlInput.setValue('https://example.test/e2e-gallery');
    await $('#url-overlay button[type="submit"]').click();

    try {
      await browser.waitUntil(
        async () => {
          const classes = (await $('#url-overlay').getAttribute('class')) || '';
          return !classes.includes('active');
        },
        { timeout: 10000, timeoutMsg: 'URL overlay did not close after importing the gallery' }
      );
    } catch (err) {
      const overlayText = await $('#url-overlay').getText().catch(() => '<unreadable>');
      const probe = await browser.execute(() => {
        const core = window.__TAURI__?.core;
        const desc = core ? Object.getOwnPropertyDescriptor(core, 'invoke') : null;
        return {
          hasOriginal: typeof window.__quivitE2eOriginalInvoke,
          callCount: Array.isArray(window.__quivitE2eFixtureCalls)
            ? window.__quivitE2eFixtureCalls.length
            : -1,
          coreExtensible: core ? Object.isExtensible(core) : null,
          invokeWritable: desc ? !!desc.writable : null,
          invokeIsMock: core
            ? String(core.invoke).includes('__quivitE2eFixtureCalls')
            : null,
        };
      }).catch(() => ({}));
      const calls = await browser.execute(
        () => (window.__quivitE2eFixtureCalls || []).map(({ command }) => command)
      ).catch(() => []);
      console.log(`[08] overlay stuck. text=${JSON.stringify(overlayText)} probe=${JSON.stringify(probe)} calls=${JSON.stringify(calls)}`);
      throw err;
    }
    await browser.waitUntil(
      async () => (await filepanelPage.breadcrumb.getText()).includes('Chapter 01'),
      { timeout: 10000, timeoutMsg: 'Nested extractor gallery did not open' }
    );

    const itemNames = await filepanelPage.getItemNames();
    expect(itemNames).toContain('001.png');
    expect(itemNames).toContain('002.png');
    const headerText = await $('.library-provider-header').getText();
    expect(headerText.toUpperCase()).toContain('E2E GALLERY');
    expect(await $('.library-provider-list .item-label').getText()).toBe('Series');

    const calls = await browser.execute(() => window.__quivitE2eFixtureCalls.map(({ command, args }) => ({ command, args })));
    const extractorPaths = calls
      .filter(({ command }) => command === 'fetch_extractor_text')
      .map(({ args }) => args.relativePath);
    expect(extractorPaths).toContain('manifest.json');
    expect(extractorPaths).toContain('e2e-gallery.js');

    const sidecar = JSON.parse(fs.readFileSync(path.join(galleryPath, 'gallery.json'), 'utf8'));
    expect(sidecar.gallery.extractorId).toBe('e2e-gallery');
    expect(sidecar.images.map((image) => image.filename)).toEqual(['001.png', '002.png']);
  });
});
