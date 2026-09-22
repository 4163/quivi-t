import assert from 'node:assert/strict';
import {
  prepareGalleryDirectory,
  resumeGalleryDownloads,
  forgetDeletedLibraryEntry
} from '../src/js/urlLoader.js';

function mockTauri(state) {
  if (!globalThis.window) globalThis.window = {};
  globalThis.window.dispatchEvent = () => {};
  globalThis.window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        state.calls.push(cmd);
        if (cmd === 'read_text_file') {
          if (state.files[args.path] !== undefined) return state.files[args.path];
          throw new Error('File not found');
        }
        if (cmd === 'read_directory') {
          return { files: state.dirFiles || [] };
        }
        if (cmd === 'download_to_file') {
          if (state.failUrls && state.failUrls.has(args.url)) throw new Error('Network request failed');
          state.downloaded.push(args.url);
          return;
        }
        if (cmd === 'write_text_file') {
          state.written = JSON.parse(args.content);
          return;
        }
        if (cmd === 'remove_file') {
          state.deleted.push(args.path);
          return;
        }
        if (cmd === 'cancel_download') return;
        throw new Error(`Unknown cmd ${cmd}`);
      }
    }
  };
  state.calls = [];
  state.downloaded = [];
  state.deleted = [];
  state.written = null;
  return state;
}

function gallerySidecar(images) {
  return JSON.stringify({
    url: 'https://north.test/g/1',
    provider: 'North',
    title: 'North Gallery',
    timestamp: new Date().toISOString(),
    gallery: { id: 'north-1', relativePath: ['North Gallery'] },
    images
  });
}

describe('url loader flows', () => {
  describe('prepareGalleryDirectory', () => {
    it('downloads a missing target before opening', async () => {
      const dir = 'C:\\library\\North\\Prep';
      const state = mockTauri({
        files: {
          [`${dir}\\gallery.json`]: gallerySidecar([
            { filename: '01.png', sourceUrl: 'https://cdn.north.test/01.png' },
            { filename: '02.png', sourceUrl: 'https://cdn.north.test/02.png' }
          ])
        },
        dirFiles: [
          { name: '01.png', size: 0 },
          { name: '02.png', size: 410 }
        ]
      });
      const ready = await prepareGalleryDirectory(dir, { targetName: '01.png' });
      assert.equal(ready, true);
      assert.deepEqual(state.downloaded, ['https://cdn.north.test/01.png']);
    });

    it('skips the download when the target is already on disk', async () => {
      const dir = 'C:\\library\\North\\Ready';
      const state = mockTauri({
        files: {
          [`${dir}\\gallery.json`]: gallerySidecar([
            { filename: '01.png', sourceUrl: 'https://cdn.north.test/01.png' }
          ])
        },
        dirFiles: [{ name: '01.png', size: 512 }]
      });
      const ready = await prepareGalleryDirectory(dir, { targetName: '01.png' });
      assert.equal(ready, true);
      assert.deepEqual(state.downloaded, []);
    });

    it('falls back to the first image without a target name', async () => {
      const dir = 'C:\\library\\North\\Fallback';
      const state = mockTauri({
        files: {
          [`${dir}\\gallery.json`]: gallerySidecar([
            { filename: '01.png', sourceUrl: 'https://cdn.north.test/01.png' }
          ])
        },
        dirFiles: []
      });
      const ready = await prepareGalleryDirectory(dir, {});
      assert.equal(ready, true);
      assert.deepEqual(state.downloaded, ['https://cdn.north.test/01.png']);
    });

    it('uses the fallback address when the primary download fails', async () => {
      const dir = 'C:\\library\\North\\FallbackUrl';
      const state = mockTauri({
        files: {
          [`${dir}\\gallery.json`]: gallerySidecar([
            { filename: '01.png', sourceUrl: 'https://cdn.north.test/01.png', fallbackUrl: 'https://static.north.test/01.png' }
          ])
        },
        dirFiles: [],
        failUrls: new Set(['https://cdn.north.test/01.png'])
      });
      const ready = await prepareGalleryDirectory(dir, { targetName: '01.png' });
      assert.equal(ready, true);
      assert.deepEqual(state.downloaded, ['https://static.north.test/01.png']);
    });

    it('returns false without a readable sidecar', async () => {
      const state = mockTauri({ files: {}, dirFiles: [] });
      const ready = await prepareGalleryDirectory('C:\\library\\North\\Missing', {});
      assert.equal(ready, false);
      assert.deepEqual(state.downloaded, []);
    });
  });

  describe('resumeGalleryDownloads', () => {
    it('resumes pending files and reports active', async () => {
      const dir = 'C:\\library\\North\\Resume';
      mockTauri({
        files: {
          [`${dir}\\gallery.json`]: gallerySidecar([
            { filename: '01.png', sourceUrl: 'https://cdn.north.test/01.png' },
            { filename: '02.png', sourceUrl: 'https://cdn.north.test/02.png' }
          ])
        }
      });
      const resumed = await resumeGalleryDownloads(dir, [
        { name: '01.png', size: 600 },
        { name: '02.png', size: 0 }
      ]);
      assert.equal(resumed, true);
    });

    it('reports false when everything is already downloaded', async () => {
      const dir = 'C:\\library\\North\\Complete';
      mockTauri({
        files: {
          [`${dir}\\gallery.json`]: gallerySidecar([
            { filename: '01.png', sourceUrl: 'https://cdn.north.test/01.png' }
          ])
        }
      });
      const resumed = await resumeGalleryDownloads(dir, [{ name: '01.png', size: 600 }]);
      assert.equal(resumed, false);
    });

    it('reports false without a sidecar', async () => {
      mockTauri({ files: {} });
      const resumed = await resumeGalleryDownloads('C:\\library\\North\\Gone', []);
      assert.equal(resumed, false);
    });
  });

  describe('forgetDeletedLibraryEntry', () => {
    it('prunes the deleted file from its gallery sidecar', async () => {
      const dir = 'C:\\library\\North\\Prune';
      const state = mockTauri({
        files: {
          [`${dir}\\gallery.json`]: gallerySidecar([
            { filename: '01.png', sourceUrl: 'https://cdn.north.test/01.png' },
            { filename: '02.png', sourceUrl: 'https://cdn.north.test/02.png' }
          ])
        }
      });
      const pruned = await forgetDeletedLibraryEntry(`${dir}\\01.png`);
      assert.equal(pruned, true);
      assert.deepEqual(state.written.images.map((img) => img.filename), ['02.png']);
    });

    it('reports false when the file is not recorded', async () => {
      const dir = 'C:\\library\\North\\Intact';
      mockTauri({
        files: {
          [`${dir}\\gallery.json`]: gallerySidecar([
            { filename: '01.png', sourceUrl: 'https://cdn.north.test/01.png' }
          ])
        }
      });
      const pruned = await forgetDeletedLibraryEntry(`${dir}\\99.png`);
      assert.equal(pruned, false);
    });
  });
});
