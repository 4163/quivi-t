import assert from 'node:assert/strict';
import {
  DownloadQueue,
  PREFETCH_START_THRESHOLD_PERCENT,
  normalizeUrl,
  isValidUrl,
  getExtractorCacheKey,
  isLibraryLocationError,
  remapLibraryPath,
  validateManifest,
  validateExtractorResult,
  findMatchingGalleryImage,
  cleanupMatchingRawFiles
} from '../src/js/urlLoader.js';
import * as ImgurExtractor from '../extractors/imgur.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushQueue() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('UrlLoader and Imgur extractor direct URL handling', () => {
  describe('staggered gallery downloads', () => {
    it('waits for the active file, then starts the next prefetch at 50%', async () => {
      const downloads = [];
      const queue = new DownloadQueue([
        { url: 'https://example.test/001.jpg', destPath: 'C:\\gallery\\001.jpg', galleryIndex: 0 },
        { url: 'https://example.test/002.jpg', destPath: 'C:\\gallery\\002.jpg', galleryIndex: 1 },
        { url: 'https://example.test/003.jpg', destPath: 'C:\\gallery\\003.jpg', galleryIndex: 2 }
      ], {
        visibleStart: 0,
        visibleEnd: 3,
        downloadFile: (_url, destPath, options) => {
          const deferred = createDeferred();
          downloads.push({ destPath, options, deferred });
          return deferred.promise;
        }
      });

      queue.prioritize('C:\\gallery\\001.jpg');
      await flushQueue();
      assert.deepEqual(downloads.map((download) => download.destPath), ['C:\\gallery\\001.jpg']);
      assert.equal(downloads[0].options.thresholdPercent, null);

      downloads[0].deferred.resolve();
      await flushQueue();
      assert.deepEqual(downloads.map((download) => download.destPath), [
        'C:\\gallery\\001.jpg',
        'C:\\gallery\\002.jpg'
      ]);
      assert.equal(downloads[1].options.thresholdPercent, PREFETCH_START_THRESHOLD_PERCENT);

      queue.handleDownloadThreshold({
        requestId: downloads[1].options.requestId,
        queueGeneration: downloads[1].options.queueGeneration
      });
      await flushQueue();
      assert.deepEqual(downloads.map((download) => download.destPath), [
        'C:\\gallery\\001.jpg',
        'C:\\gallery\\002.jpg',
        'C:\\gallery\\003.jpg'
      ]);

      queue.cancel();
    });

    it('discards stale completion after a jump cancels the active request', async () => {
      const downloads = [];
      let cancelCount = 0;
      const queue = new DownloadQueue([
        { url: 'https://example.test/001.jpg', destPath: 'C:\\gallery\\001.jpg', galleryIndex: 0 },
        { url: 'https://example.test/002.jpg', destPath: 'C:\\gallery\\002.jpg', galleryIndex: 1 },
        { url: 'https://example.test/003.jpg', destPath: 'C:\\gallery\\003.jpg', galleryIndex: 2 }
      ], {
        visibleStart: 0,
        visibleEnd: 3,
        cancelDownload: async () => { cancelCount++; },
        downloadFile: (_url, destPath, options) => {
          const deferred = createDeferred();
          downloads.push({ destPath, options, deferred });
          return deferred.promise;
        }
      });

      queue.prioritize('C:\\gallery\\001.jpg');
      await flushQueue();
      queue.prioritize('C:\\gallery\\003.jpg');
      await flushQueue();

      assert.equal(cancelCount, 1);
      assert.deepEqual(downloads.map((download) => download.destPath), [
        'C:\\gallery\\001.jpg',
        'C:\\gallery\\003.jpg'
      ]);
      assert.equal(queue.getStatus('C:\\gallery\\001.jpg'), 'pending');

      downloads[0].deferred.resolve();
      await flushQueue();
      assert.equal(queue.getStatus('C:\\gallery\\001.jpg'), 'pending');
      assert.equal(queue.getStatus('C:\\gallery\\003.jpg'), 'downloading');

      queue.cancel();
    });

    it('reports a failed image after its single retry and restarts it on priority', async () => {
      const statuses = [];
      let attempts = 0;
      const queue = new DownloadQueue([
        { url: 'https://example.test/broken.jpg', destPath: 'C:\\gallery\\broken.jpg', galleryIndex: 0 }
      ], {
        visibleStart: 0,
        visibleEnd: 1,
        downloadFile: async () => {
          attempts++;
          throw new Error('Network request failed');
        },
        onItemStatusChanged: (_destPath, status) => statuses.push(status)
      });

      queue.prioritize('C:\\gallery\\broken.jpg');
      await flushQueue();

      assert.equal(attempts, 2);
      assert.equal(queue.getStatus('C:\\gallery\\broken.jpg'), 'error');
      assert.deepEqual(statuses, ['downloading', 'error']);

      queue.prioritize('C:\\gallery\\broken.jpg');
      await flushQueue();
      assert.equal(attempts, 4);
      assert.equal(queue.getStatus('C:\\gallery\\broken.jpg'), 'error');

      queue.cancel();
    });
  });

  describe('library relocation recovery', () => {
    it('recognizes retired-path and relocation rejections in either shape', () => {
      assert.equal(isLibraryLocationError('This Library location was retired by a live move. Reload QuiviT before downloading or changing its files.'), true);
      assert.equal(isLibraryLocationError('Library relocation is in progress. The pending write was cancelled.'), true);
      assert.equal(isLibraryLocationError(new Error('Library relocation is in progress. The pending write was cancelled.')), true);
      assert.equal(isLibraryLocationError('Network request failed'), false);
      assert.equal(isLibraryLocationError(new Error('No images found in gallery')), false);
      assert.equal(isLibraryLocationError(null), false);
    });

    it('remaps stale library paths onto the live root', () => {
      assert.equal(
        remapLibraryPath('C:\\old\\Library\\Imgur\\g', 'C:\\old\\Library', 'D:\\Lib'),
        'D:\\Lib\\Imgur\\g'
      );
      assert.equal(
        remapLibraryPath('C:\\old\\Library', 'C:\\old\\Library', 'D:\\Lib'),
        'D:\\Lib'
      );
      assert.equal(
        remapLibraryPath('C:\\other\\place', 'C:\\old\\Library', 'D:\\Lib'),
        'C:\\other\\place'
      );
      assert.equal(
        remapLibraryPath('C:\\old\\Library\\g', 'C:\\old\\Library', 'C:\\old\\Library'),
        'C:\\old\\Library\\g'
      );
    });
  });

  describe('normalizeUrl and isValidUrl', () => {
    it('upgrades http to https', () => {
      assert.equal(normalizeUrl('http://i.imgur.com/04XS16K.png'), 'https://i.imgur.com/04XS16K.png');
      assert.equal(normalizeUrl('http://imgur.com/a/17vF37d'), 'https://imgur.com/a/17vF37d');
    });

    it('prepends https to protocol-less URLs', () => {
      assert.equal(normalizeUrl('i.imgur.com/04XS16K.png'), 'https://i.imgur.com/04XS16K.png');
      assert.equal(normalizeUrl('imgur.com/a/17vF37d'), 'https://imgur.com/a/17vF37d');
    });

    it('validates URLs correctly', () => {
      assert.equal(isValidUrl('https://i.imgur.com/04XS16K.png'), true);
      assert.equal(isValidUrl('i.imgur.com/04XS16K.png'), true);
      assert.equal(isValidUrl('not a url %%%'), false);
      assert.equal(isValidUrl(''), false);
    });
  });

  describe('remote extractor contract', () => {
    const manifestEntry = {
      id: 'example',
      name: 'Example',
      libraryPath: 'Example',
      version: 1,
      source: 'example.js',
      patterns: ['^https://example\\.test/']
    };

    it('accepts a versioned manifest and a safe nested gallery result', () => {
      const manifest = validateManifest({ version: 1, extractors: [manifestEntry] });
      assert.equal(manifest.extractors[0].id, 'example');

      const result = validateExtractorResult({
        provider: 'Example',
        gallery: { id: 'series-42', relativePath: ['Series', 'Volume 01', 'Chapter 02'] },
        images: [{ url: 'https://cdn.example.test/001.png', filename: '001.png' }]
      }, manifestEntry);
      assert.equal(result.gallery.relativePath[2], 'Chapter 02');
    });

    it('rejects unsafe paths, duplicate filenames, and malformed manifest sources', () => {
      assert.throws(() => validateExtractorResult({
        provider: 'Example',
        gallery: { id: 'series-42', relativePath: ['Series', '..'] },
        images: [{ url: 'https://cdn.example.test/001.png', filename: '001.png' }]
      }, manifestEntry), /unsafe gallery path segment/);

      assert.throws(() => validateExtractorResult({
        provider: 'Example',
        gallery: { id: 'series-42', relativePath: ['Series'] },
        images: [
          { url: 'https://cdn.example.test/001.png', filename: '001.png' },
          { url: 'https://cdn.example.test/002.png', filename: '001.png' }
        ]
      }, manifestEntry), /duplicate filename/);

      assert.throws(() => validateExtractorResult({
        provider: 'Example',
        gallery: { id: 'series-42', relativePath: ['Series'] },
        images: [{ url: 'https://cdn.example.test/001.png', filename: 'CON.png' }]
      }, manifestEntry), /unsafe filename/);

      assert.throws(() => validateManifest({
        version: 1,
        extractors: [{ ...manifestEntry, source: '../example.js' }]
      }), /invalid/);

      assert.throws(() => validateManifest({
        version: 1,
        extractors: [{ ...manifestEntry, libraryPath: '..' }]
      }), /unsafe library path/);
    });

    it('changes the module cache key when a remote extractor changes', () => {
      assert.notEqual(
        getExtractorCacheKey({ id: 'example', version: 1, source: 'example.js' }),
        getExtractorCacheKey({ id: 'example', version: 2, source: 'example.js' })
      );
      assert.notEqual(
        getExtractorCacheKey({ id: 'example', version: 2, source: 'example.js' }),
        getExtractorCacheKey({ id: 'example', version: 2, source: 'sites/example.js' })
      );
    });
  });

  describe('Imgur extractor direct URL parsing', () => {
    it('matches albums, galleries, direct images, and single posts', () => {
      assert.equal(ImgurExtractor.match('https://imgur.com/a/17vF37d'), true);
      assert.equal(ImgurExtractor.match('https://imgur.com/gallery/17vF37d'), true);
      assert.equal(ImgurExtractor.match('https://i.imgur.com/04XS16K.png'), true);
      assert.equal(ImgurExtractor.match('https://imgur.com/04XS16K.jpg'), true);
      assert.equal(ImgurExtractor.match('https://imgur.com/04XS16K'), true);
      assert.equal(ImgurExtractor.match('https://example.com/other'), false);
    });

    it('identifies and parses direct image URLs', () => {
      assert.equal(ImgurExtractor.isDirectUrl('https://i.imgur.com/04XS16K.png'), true);
      assert.equal(ImgurExtractor.isDirectUrl('https://imgur.com/a/17vF37d'), false);

      const parsed = ImgurExtractor.parseDirectUrl('https://i.imgur.com/04XS16K.png');
      assert.deepEqual(parsed, {
        provider: 'Imgur',
        hash: '04XS16K',
        ext: '.png',
        filename: '04XS16K.png',
        url: 'https://i.imgur.com/04XS16K.png'
      });
    });

    it('strips only the final matching image format from descriptions', async () => {
      const ajaxBody = JSON.stringify({
        data: {
          images: [
            { hash: 'first', ext: '.png', description: 'First.png' },
            { hash: 'second', ext: '.png', description: 'Keep.jpg' },
            { hash: 'third', ext: '.png', description: 'Repeat.png.png' }
          ]
        }
      });
      const gallery = await ImgurExtractor.extract('<title>Format handling - Imgur</title>', 'https://imgur.com/a/formattest', {
        fetchText: async () => ajaxBody
      });

      assert.deepEqual(gallery.images.map((image) => image.description), [
        'First',
        'Keep.jpg',
        'Repeat.png'
      ]);
      assert.deepEqual(gallery.images.map((image) => image.filename), [
        '1_First.png',
        '2_Keep.jpg.png',
        '3_Repeat.png.png'
      ]);
      assert.deepEqual(gallery.gallery, {
        id: 'imgur-formattest',
        relativePath: ['Format handling']
      });
    });
  });

  describe('findMatchingGalleryImage', () => {
    it('returns null when window.__TAURI__ is unavailable', async () => {
      const origTauri = globalThis.window?.__TAURI__;
      try {
        if (globalThis.window) globalThis.window.__TAURI__ = undefined;
        const res = await findMatchingGalleryImage('C:\\library\\Imgur', 'https://i.imgur.com/04XS16K.png', '04XS16K');
        assert.equal(res, null);
      } finally {
        if (globalThis.window) globalThis.window.__TAURI__ = origTauri;
      }
    });

    it('finds matching image inside an existing gallery sidecar', async () => {
      if (!globalThis.window) globalThis.window = {};

      const mockDirs = {
        'C:\\library\\Imgur': {
          files: [
            { name: 'Azuma - Seihantai', path: 'C:\\library\\Imgur\\Azuma - Seihantai', is_dir: true },
            { name: 'Other Gallery', path: 'C:\\library\\Imgur\\Other Gallery', is_dir: true }
          ]
        }
      };

      const mockFiles = {
        'C:\\library\\Imgur\\Azuma - Seihantai\\gallery.json': JSON.stringify({
          url: 'https://imgur.com/a/17vF37d',
          provider: 'Imgur',
          images: [
            { filename: '01.png', sourceUrl: 'https://i.imgur.com/04XS16K.png' },
            { filename: '02.png', sourceUrl: 'https://i.imgur.com/ABC1234.png' }
          ]
        }),
        'C:\\library\\Imgur\\Other Gallery\\gallery.json': JSON.stringify({
          url: 'https://imgur.com/a/other',
          provider: 'Imgur',
          images: [
            { filename: '01.jpg', sourceUrl: 'https://i.imgur.com/XYZ9999.jpg' }
          ]
        })
      };

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') {
              return mockDirs[args.path] || { files: [] };
            }
            if (cmd === 'read_text_file') {
              if (mockFiles[args.path]) return mockFiles[args.path];
              throw new Error('File not found');
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const match = await findMatchingGalleryImage(
        'C:\\library\\Imgur',
        'https://i.imgur.com/04XS16K.png',
        '04XS16K'
      );

      assert.ok(match);
      assert.equal(match.galleryPath, 'C:\\library\\Imgur\\Azuma - Seihantai');
      assert.equal(match.targetName, '01.png');

      // Non-matching image returns null
      const noMatch = await findMatchingGalleryImage(
        'C:\\library\\Imgur',
        'https://i.imgur.com/NOTFOUND.png',
        'NOTFOUND'
      );
      assert.equal(noMatch, null);
    });
  });

  describe('cleanupMatchingRawFiles', () => {
    it('removes standalone raw files matching gallery image hashes and leaves others untouched', async () => {
      if (!globalThis.window) globalThis.window = {};

      const deleted = [];
      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') {
              return {
                files: [
                  { name: '04XS16K.png', path: 'C:\\library\\Imgur\\04XS16K.png', is_dir: false },
                  { name: 'unrelated.png', path: 'C:\\library\\Imgur\\unrelated.png', is_dir: false },
                  { name: 'Azuma - Seihantai', path: 'C:\\library\\Imgur\\Azuma - Seihantai', is_dir: true }
                ]
              };
            }
            if (cmd === 'remove_file') {
              deleted.push(args.path);
              return;
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const galleryImages = [
        { filename: '01.png', sourceUrl: 'https://i.imgur.com/04XS16K.png' },
        { filename: '02.png', sourceUrl: 'https://i.imgur.com/OTHER55.png' }
      ];

      await cleanupMatchingRawFiles('C:\\library\\Imgur', galleryImages);

      // Only 04XS16K.png should be deleted
      assert.equal(deleted.length, 1);
      assert.equal(deleted[0], 'C:\\library\\Imgur\\04XS16K.png');
    });
  });
});
