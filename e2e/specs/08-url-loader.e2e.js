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
      const core = window.__TAURI__.core;
      window.__quivitE2eOriginalInvoke = core.invoke.bind(core);
      window.__quivitE2eFixtureCalls = [];
      core.invoke = async (command, args = {}) => {
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
        return window.__quivitE2eOriginalInvoke(command, args);
      };
    }, manifest, extractorSource);
  });

  after(async () => {
    await browser.execute(() => {
      if (window.__quivitE2eOriginalInvoke) {
        window.__TAURI__.core.invoke = window.__quivitE2eOriginalInvoke;
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

    await browser.waitUntil(
      async () => {
        const classes = (await $('#url-overlay').getAttribute('class')) || '';
        return !classes.includes('active');
      },
      { timeout: 10000, timeoutMsg: 'URL overlay did not close after importing the gallery' }
    );
    await browser.waitUntil(
      async () => (await filepanelPage.breadcrumb.getText()).includes('Chapter 01'),
      { timeout: 10000, timeoutMsg: 'Nested extractor gallery did not open' }
    );

    const itemNames = await filepanelPage.getItemNames();
    expect(itemNames).toContain('001.png');
    expect(itemNames).toContain('002.png');
    expect(await $('.library-provider-header').getText()).toContain('E2E Gallery');
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
