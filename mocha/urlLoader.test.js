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
  cleanupMatchingRawFiles,
  cleanupMatchingProviderEntries,
  findMatchingGalleryBySourceUrl,
  extractUrlStem,
  isDirectMediaUrl,
  findExtractor,
  recordRootMediaDownload,
  writeGalleryMetadata,
  buildMatchSets,
  addCoverIdentifiers,
  matchSidecarRecord,
  buildStubCoverRecord,
  sanitizeSvgText,
  expandSvgEntities,
  downloadSanitizedSvg,
  downloadFile
} from '../src/js/urlLoader.js';
import * as ImgurExtractor from '../extractors/imgur.js';
import * as MangaDexExtractor from '../extractors/mangadex.js';
import fs from 'node:fs';

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

    it('falls back to fallbackUrl when primary url fails', async () => {
      const urlsAttempted = [];
      const queue = new DownloadQueue([
        {
          url: 'https://cdn.example.test/001.jpg',
          fallbackUrl: 'https://origin.example.test/001.jpg',
          destPath: 'C:\\gallery\\001.jpg',
          galleryIndex: 0
        }
      ], {
        visibleStart: 0,
        visibleEnd: 1,
        downloadFile: async (url) => {
          urlsAttempted.push(url);
          if (url.includes('cdn')) {
            throw new Error('CDN gateway timeout 504');
          }
        }
      });

      queue.prioritize('C:\\gallery\\001.jpg');
      await flushQueue();

      assert.deepEqual(urlsAttempted, [
        'https://cdn.example.test/001.jpg',
        'https://origin.example.test/001.jpg'
      ]);
      assert.equal(queue.getStatus('C:\\gallery\\001.jpg'), 'completed');

      queue.cancel();
    });

    it('continues prefetching backlog items when visible range is empty or unset', async () => {
      const downloaded = [];
      const queue = new DownloadQueue([
        { url: 'https://example.test/001.jpg', destPath: 'C:\\gallery\\001.jpg', galleryIndex: 0 },
        { url: 'https://example.test/002.jpg', destPath: 'C:\\gallery\\002.jpg', galleryIndex: 1 },
        { url: 'https://example.test/003.jpg', destPath: 'C:\\gallery\\003.jpg', galleryIndex: 2 }
      ], {
        visibleStart: 0,
        visibleEnd: 0,
        downloadFile: async (_url, destPath) => {
          downloaded.push(destPath);
        }
      });

      queue.prioritize('C:\\gallery\\001.jpg');
      await flushQueue();

      assert.deepEqual(downloaded, [
        'C:\\gallery\\001.jpg',
        'C:\\gallery\\002.jpg',
        'C:\\gallery\\003.jpg'
      ]);

      queue.cancel();
    });

    it('restricts downloads strictly to the visible range and stops without draining backlog', async () => {
      const downloaded = [];
      const queue = new DownloadQueue([
        { url: 'https://example.test/001.jpg', destPath: 'C:\\gallery\\001.jpg', galleryIndex: 0 },
        { url: 'https://example.test/002.jpg', destPath: 'C:\\gallery\\002.jpg', galleryIndex: 1 },
        { url: 'https://example.test/003.jpg', destPath: 'C:\\gallery\\003.jpg', galleryIndex: 2 },
        { url: 'https://example.test/004.jpg', destPath: 'C:\\gallery\\004.jpg', galleryIndex: 3 },
        { url: 'https://example.test/005.jpg', destPath: 'C:\\gallery\\005.jpg', galleryIndex: 4 }
      ], {
        visibleStart: 0,
        visibleEnd: 2,
        downloadFile: async (_url, destPath) => {
          downloaded.push(destPath);
        }
      });

      queue.prioritize('C:\\gallery\\001.jpg');
      await flushQueue();

      // Only items within visible range [0, 2) should download
      assert.deepEqual(downloaded, [
        'C:\\gallery\\001.jpg',
        'C:\\gallery\\002.jpg'
      ]);

      // Scrolling down to [2, 4) admits the next slice without downloading offscreen item 4
      queue.setVisibleRange(2, 4);
      await flushQueue();

      assert.deepEqual(downloaded, [
        'C:\\gallery\\001.jpg',
        'C:\\gallery\\002.jpg',
        'C:\\gallery\\003.jpg',
        'C:\\gallery\\004.jpg'
      ]);

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
        images: [{ url: 'https://cdn.example.test/001.png', filename: '001.png' }],
        targetFilename: '001.png'
      }, manifestEntry);
      assert.equal(result.gallery.relativePath[2], 'Chapter 02');
      assert.equal(result.targetFilename, '001.png');
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

      assert.throws(() => validateExtractorResult({
        provider: 'Example',
        gallery: { id: 'series-42', relativePath: ['Series'] },
        images: [{ url: 'https://cdn.example.test/001.png', filename: '001.png' }],
        targetFilename: '   '
      }, manifestEntry), /targetFilename/);

      assert.throws(() => validateExtractorResult({
        provider: 'Example',
        gallery: { id: 'series-42', relativePath: ['Series'] },
        images: [{ url: 'https://cdn.example.test/001.png', filename: '001.png' }],
        targetFilename: 123
      }, manifestEntry), /targetFilename/);

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
        '1 - First.png',
        '2 - Keep.jpg.png',
        '3 - Repeat.png.png'
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

    it('finds matching video entry for non-Imgur provider using generic stem', async () => {
      const mockDirs = {
        'C:\\library\\Example': {
          files: [
            { name: 'Video Album', path: 'C:\\library\\Example\\Video Album', is_dir: true }
          ]
        }
      };

      const mockFiles = {
        'C:\\library\\Example\\Video Album\\gallery.json': JSON.stringify({
          url: 'https://example.test/album/1',
          provider: 'Example',
          images: [
            { filename: '1_sample_clip.mp4', sourceUrl: 'https://cdn.example.test/videos/sample_clip.mp4' }
          ]
        })
      };

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') return mockDirs[args.path] || { files: [] };
            if (cmd === 'read_text_file') {
              if (mockFiles[args.path]) return mockFiles[args.path];
              throw new Error('File not found');
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const match = await findMatchingGalleryImage(
        'C:\\library\\Example',
        'https://cdn.example.test/videos/sample_clip.mp4'
      );

      assert.ok(match);
      assert.equal(match.galleryPath, 'C:\\library\\Example\\Video Album');
      assert.equal(match.targetName, '1_sample_clip.mp4');
    });

    it('prioritizes content image in child gallery over parent series Cover.jpg placeholder', async () => {
      const mockDirs = {
        'C:\\library\\MangaDex': {
          files: [
            { name: 'Akebi (Covers)', path: 'C:\\library\\MangaDex\\Akebi (Covers)', is_dir: true }
          ]
        },
        'C:\\library\\MangaDex\\Akebi (Covers)': {
          files: [
            { name: 'Japanese', path: 'C:\\library\\MangaDex\\Akebi (Covers)\\Japanese', is_dir: true }
          ]
        },
        'C:\\library\\MangaDex\\Akebi (Covers)\\Japanese': {
          files: []
        }
      };

      const mockFiles = {
        'C:\\library\\MangaDex\\Akebi (Covers)\\gallery.json': JSON.stringify({
          url: 'https://mangadex.org/title/123?tab=art',
          provider: 'MangaDex',
          images: [
            {
              filename: 'Cover.jpg',
              description: 'Series Cover',
              sourceUrl: 'https://uploads.mangadex.org/covers/123/hash16.jpg'
            }
          ]
        }),
        'C:\\library\\MangaDex\\Akebi (Covers)\\Japanese\\gallery.json': JSON.stringify({
          url: 'https://mangadex.org/title/123?tab=art&locale=ja',
          provider: 'MangaDex',
          images: [
            {
              filename: 'Vol. 16.jpg',
              description: 'Volume 16',
              sourceUrl: 'https://uploads.mangadex.org/covers/123/hash16.jpg'
            }
          ]
        })
      };

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') return mockDirs[args.path] || { files: [] };
            if (cmd === 'read_text_file') {
              if (mockFiles[args.path]) return mockFiles[args.path];
              throw new Error('File not found');
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const match = await findMatchingGalleryImage(
        'C:\\library\\MangaDex',
        'https://mangadex.org/covers/123/hash16.jpg',
        'hash16'
      );

      assert.ok(match);
      assert.equal(match.galleryPath, 'C:\\library\\MangaDex\\Akebi (Covers)\\Japanese');
      assert.equal(match.targetName, 'Vol. 16.jpg');
    });

    it('falls back to parent series Cover.jpg if child gallery image was not downloaded', async () => {
      const mockDirs = {
        'C:\\library\\MangaDex': {
          files: [
            { name: 'Akebi (Covers)', path: 'C:\\library\\MangaDex\\Akebi (Covers)', is_dir: true }
          ]
        },
        'C:\\library\\MangaDex\\Akebi (Covers)': {
          files: []
        }
      };

      const mockFiles = {
        'C:\\library\\MangaDex\\Akebi (Covers)\\gallery.json': JSON.stringify({
          url: 'https://mangadex.org/title/123?tab=art',
          provider: 'MangaDex',
          images: [
            {
              filename: 'Cover.jpg',
              description: 'Series Cover',
              sourceUrl: 'https://uploads.mangadex.org/covers/123/hash16.jpg'
            }
          ]
        })
      };

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') return mockDirs[args.path] || { files: [] };
            if (cmd === 'read_text_file') {
              if (mockFiles[args.path]) return mockFiles[args.path];
              throw new Error('File not found');
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const match = await findMatchingGalleryImage(
        'C:\\library\\MangaDex',
        'https://mangadex.org/covers/123/hash16.jpg',
        'hash16'
      );

      assert.ok(match);
      assert.equal(match.galleryPath, 'C:\\library\\MangaDex\\Akebi (Covers)');
      assert.equal(match.targetName, 'Cover.jpg');
    });

    it('prefers content over covers and breaks cover ties by path order', async () => {
      const mockDirs = {
        'C:\\library\\MangaDex': {
          files: [
            { name: 'Akebi', path: 'C:\\library\\MangaDex\\Akebi', is_dir: true },
            { name: 'Akebi (Covers)', path: 'C:\\library\\MangaDex\\Akebi (Covers)', is_dir: true }
          ]
        },
        'C:\\library\\MangaDex\\Akebi': { files: [] },
        'C:\\library\\MangaDex\\Akebi (Covers)': {
          files: [
            { name: 'Japanese', path: 'C:\\library\\MangaDex\\Akebi (Covers)\\Japanese', is_dir: true }
          ]
        },
        'C:\\library\\MangaDex\\Akebi (Covers)\\Japanese': { files: [] }
      };

      const mockFiles = {
        'C:\\library\\MangaDex\\Akebi\\gallery.json': JSON.stringify({
          url: 'https://mangadex.org/title/123',
          provider: 'MangaDex',
          title: 'Akebi',
          images: [
            {
              filename: 'Cover.jpg',
              description: 'Series Cover',
              sourceUrl: 'https://uploads.mangadex.org/covers/123/hash16.jpg'
            }
          ]
        }),
        'C:\\library\\MangaDex\\Akebi (Covers)\\gallery.json': JSON.stringify({
          url: 'https://mangadex.org/title/123?tab=art',
          provider: 'MangaDex',
          title: 'Akebi (Covers)',
          images: [
            {
              filename: 'Cover.jpg',
              description: 'Series Cover',
              sourceUrl: 'https://uploads.mangadex.org/covers/123/hash16.jpg'
            }
          ]
        }),
        'C:\\library\\MangaDex\\Akebi (Covers)\\Japanese\\gallery.json': JSON.stringify({
          url: 'https://mangadex.org/title/123?tab=art&locale=ja',
          provider: 'MangaDex',
          title: 'Akebi - Covers (Japanese)',
          images: [
            {
              filename: 'Vol. 16.jpg',
              description: 'Volume 16',
              sourceUrl: 'https://uploads.mangadex.org/covers/123/hash16.jpg'
            }
          ]
        })
      };

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') return mockDirs[args.path] || { files: [] };
            if (cmd === 'read_text_file') {
              if (mockFiles[args.path]) return mockFiles[args.path];
              throw new Error('File not found');
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      // 1. All three present: Priority 1 wins (Japanese/Vol. 16.jpg)
      const match1 = await findMatchingGalleryImage(
        'C:\\library\\MangaDex',
        'https://mangadex.org/covers/123/hash16.jpg',
        'hash16'
      );
      assert.ok(match1);
      assert.equal(match1.galleryPath, 'C:\\library\\MangaDex\\Akebi (Covers)\\Japanese');
      assert.equal(match1.targetName, 'Vol. 16.jpg');

      // 2. Remove child gallery Vol. 16.jpg: cover tie breaks by path order (Akebi/Cover.jpg sorts before Akebi (Covers)/Cover.jpg)
      delete mockFiles['C:\\library\\MangaDex\\Akebi (Covers)\\Japanese\\gallery.json'];
      const match2 = await findMatchingGalleryImage(
        'C:\\library\\MangaDex',
        'https://mangadex.org/covers/123/hash16.jpg',
        'hash16'
      );
      assert.ok(match2);
      assert.equal(match2.galleryPath, 'C:\\library\\MangaDex\\Akebi');
      assert.equal(match2.targetName, 'Cover.jpg');

      // 3. Remove covers collection: Priority 3 wins (Akebi/Cover.jpg)
      delete mockFiles['C:\\library\\MangaDex\\Akebi (Covers)\\gallery.json'];
      const match3 = await findMatchingGalleryImage(
        'C:\\library\\MangaDex',
        'https://mangadex.org/covers/123/hash16.jpg',
        'hash16'
      );
      assert.ok(match3);
      assert.equal(match3.galleryPath, 'C:\\library\\MangaDex\\Akebi');
      assert.equal(match3.targetName, 'Cover.jpg');
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

    it('cleans up loose raw video files for non-Imgur providers using generic stems', async () => {
      const deleted = [];
      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') {
              return {
                files: [
                  { name: 'sample_clip.mp4', path: 'C:\\library\\Example\\sample_clip.mp4', is_dir: false },
                  { name: 'other_video.mp4', path: 'C:\\library\\Example\\other_video.mp4', is_dir: false }
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
        { filename: '1_sample_clip.mp4', sourceUrl: 'https://cdn.example.test/videos/sample_clip.mp4?auth=xyz' }
      ];

      await cleanupMatchingRawFiles('C:\\library\\Example', galleryImages);
      assert.equal(deleted.length, 1);
      assert.equal(deleted[0], 'C:\\library\\Example\\sample_clip.mp4');
    });
  });

  describe('cleanupMatchingProviderEntries', () => {
    it('removes matching standalone chapter directories but preserves loose covers when removeLooseCovers is false', async () => {
      if (!globalThis.window) globalThis.window = {};

      const deletedFiles = [];
      const deletedDirs = [];

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') {
              return {
                files: [
                  { name: 'Akebi-chan no Sailor Fuku', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku', is_dir: true },
                  { name: 'Akebi-chan no Sailor Fuku - Ch. 0 - Prologue', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku - Ch. 0 - Prologue', is_dir: true },
                  { name: 'Unrelated Manga - Ch. 1', path: 'C:\\library\\MangaDex\\Unrelated Manga - Ch. 1', is_dir: true },
                  { name: '47df7fb5-dc37-492f-98bc-affe54b74960.jpg', path: 'C:\\library\\MangaDex\\47df7fb5-dc37-492f-98bc-affe54b74960.jpg', is_dir: false },
                  { name: '08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg', path: 'C:\\library\\MangaDex\\08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg', is_dir: false },
                  { name: 'Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg', is_dir: false }
                ]
              };
            }
            if (cmd === 'read_text_file') {
              if (args.path.includes('Akebi-chan no Sailor Fuku - Ch. 0 - Prologue')) {
                return JSON.stringify({
                  gallery: { id: 'mangadex-0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d' },
                  url: 'https://mangadex.org/chapter/0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d'
                });
              }
              if (args.path.includes('Unrelated Manga - Ch. 1')) {
                return JSON.stringify({
                  gallery: { id: 'mangadex-99999999-9999-9999-9999-999999999999' },
                  url: 'https://mangadex.org/chapter/99999999-9999-9999-9999-999999999999'
                });
              }
              throw new Error('Not found');
            }
            if (cmd === 'remove_directory') {
              deletedDirs.push(args.path);
              return;
            }
            if (cmd === 'remove_file') {
              deletedFiles.push(args.path);
              return;
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const seriesResult = {
        provider: 'MangaDex',
        isSeries: true,
        title: 'Akebi-chan no Sailor Fuku',
        rootRelativePath: ['Akebi-chan no Sailor Fuku'],
        cleanup: {
          removeMatchingChapters: true,
          removeLooseCovers: false
        },
        cover: {
          url: 'https://uploads.mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg',
          filename: 'Cover.jpg',
          hash: '47df7fb5-dc37-492f-98bc-affe54b74960',
          volume: '16'
        },
        chapters: [
          {
            id: 'mangadex-0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d',
            sourceUrl: 'https://mangadex.org/chapter/0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d'
          }
        ]
      };

      await cleanupMatchingProviderEntries('C:\\library\\MangaDex', seriesResult);

      assert.deepEqual(deletedDirs, [
        'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku - Ch. 0 - Prologue'
      ]);
      assert.deepEqual(deletedFiles, []);
    });

    it('only removes exact matching cover hashes when removeLooseCovers is true', async () => {
      if (!globalThis.window) globalThis.window = {};

      const deletedFiles = [];
      const deletedDirs = [];

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') {
              return {
                files: [
                  { name: '47df7fb5-dc37-492f-98bc-affe54b74960.jpg', path: 'C:\\library\\MangaDex\\47df7fb5-dc37-492f-98bc-affe54b74960.jpg', is_dir: false },
                  { name: 'Akebi-chan no Sailor Fuku - Vol. 16 Cover.jpg', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku - Vol. 16 Cover.jpg', is_dir: false },
                  { name: '08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg', path: 'C:\\library\\MangaDex\\08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg', is_dir: false },
                  { name: 'Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg', is_dir: false }
                ]
              };
            }
            if (cmd === 'remove_file') {
              deletedFiles.push(args.path);
              return;
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const seriesResult = {
        provider: 'MangaDex',
        isSeries: true,
        title: 'Akebi-chan no Sailor Fuku',
        rootRelativePath: ['Akebi-chan no Sailor Fuku'],
        cleanup: {
          removeLooseCovers: true
        },
        cover: {
          url: 'https://uploads.mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg',
          filename: 'Cover.jpg',
          hash: '47df7fb5-dc37-492f-98bc-affe54b74960',
          volume: '16'
        },
        chapters: []
      };

      await cleanupMatchingProviderEntries('C:\\library\\MangaDex', seriesResult);

      // Exact Vol 16 hash and exact Vol 16 title match are deleted, Vol 1 files are preserved
      assert.deepEqual(deletedFiles, [
        'C:\\library\\MangaDex\\47df7fb5-dc37-492f-98bc-affe54b74960.jpg',
        'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku - Vol. 16 Cover.jpg'
      ]);
    });

    it('removes all matching loose root covers across multiple volumes when covers array is provided', async () => {
      if (!globalThis.window) globalThis.window = {};

      const deletedFiles = [];

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') {
              return {
                files: [
                  { name: '47df7fb5-dc37-492f-98bc-affe54b74960.jpg', path: 'C:\\library\\MangaDex\\47df7fb5-dc37-492f-98bc-affe54b74960.jpg', is_dir: false },
                  { name: 'Akebi-chan no Sailor Fuku - Vol. 16 Cover.jpg', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku - Vol. 16 Cover.jpg', is_dir: false },
                  { name: '08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg', path: 'C:\\library\\MangaDex\\08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg', is_dir: false },
                  { name: 'Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg', is_dir: false },
                  { name: 'unrelated_series_cover.jpg', path: 'C:\\library\\MangaDex\\unrelated_series_cover.jpg', is_dir: false },
                  { name: 'keep_me.png', path: 'C:\\library\\MangaDex\\keep_me.png', is_dir: false }
                ]
              };
            }
            if (cmd === 'remove_file') {
              deletedFiles.push(args.path);
              return;
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const artResult = {
        provider: 'MangaDex',
        isSeries: true,
        title: 'Akebi-chan no Sailor Fuku',
        rootRelativePath: ['Akebi-chan no Sailor Fuku (Covers)'],
        cleanup: {
          removeLooseCovers: true
        },
        covers: [
          {
            hash: '47df7fb5-dc37-492f-98bc-affe54b74960',
            rawFileName: '47df7fb5-dc37-492f-98bc-affe54b74960.jpg',
            volume: '16',
            url: 'https://uploads.mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg'
          },
          {
            hash: '08812a68-c09d-48a8-9b3d-e0326a25b00f',
            rawFileName: '08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg',
            volume: '1',
            url: 'https://uploads.mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg'
          }
        ],
        chapters: []
      };

      await cleanupMatchingProviderEntries('C:\\library\\MangaDex', artResult);

      assert.deepEqual(deletedFiles, [
        'C:\\library\\MangaDex\\47df7fb5-dc37-492f-98bc-affe54b74960.jpg',
        'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku - Vol. 16 Cover.jpg',
        'C:\\library\\MangaDex\\08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg',
        'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg'
      ]);
    });

    it('records root direct downloads into gallery.json and deduplicates entries', async () => {
      if (!globalThis.window) globalThis.window = {};

      const writtenFiles = {};

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_text_file') {
              if (writtenFiles[args.path]) return writtenFiles[args.path];
              throw new Error('File not found');
            }
            if (cmd === 'write_text_file') {
              writtenFiles[args.path] = args.content;
              return;
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      await recordRootMediaDownload('C:\\library\\MangaDex', 'MangaDex', {
        filename: 'Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg',
        rawFileName: '08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg',
        hash: '08812a68-c09d-48a8-9b3d-e0326a25b00f',
        sourceUrl: 'https://mangadex.org/covers/770c61b9/08812a68.jpg',
        url: 'https://uploads.mangadex.org/covers/770c61b9/08812a68.jpg'
      });

      const sidecar = JSON.parse(writtenFiles['C:\\library\\MangaDex\\gallery.json']);
      assert.equal(sidecar.isRoot, true);
      assert.equal(sidecar.provider, 'MangaDex');
      assert.equal(sidecar.images.length, 1);
      assert.equal(sidecar.images[0].filename, 'Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg');
      assert.equal(sidecar.images[0].rawFileName, '08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg');
      assert.equal(sidecar.images[0].hash, '08812a68-c09d-48a8-9b3d-e0326a25b00f');

      // Recording same item again updates existing entry without duplicate
      await recordRootMediaDownload('C:\\library\\MangaDex', 'MangaDex', {
        filename: 'Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg',
        rawFileName: '08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg',
        hash: '08812a68-c09d-48a8-9b3d-e0326a25b00f',
        sourceUrl: 'https://mangadex.org/covers/770c61b9/08812a68.jpg',
        url: 'https://uploads.mangadex.org/covers/770c61b9/08812a68.jpg'
      });

      const updated = JSON.parse(writtenFiles['C:\\library\\MangaDex\\gallery.json']);
      assert.equal(updated.images.length, 1);
    });

    it('cleans up loose covers recorded in root gallery.json and prunes sidecar', async () => {
      if (!globalThis.window) globalThis.window = {};

      const deletedFiles = [];
      let updatedSidecarContent = null;
      let sidecarDeleted = false;

      const initialSidecar = {
        provider: 'MangaDex',
        isRoot: true,
        images: [
          {
            filename: 'Custom Cover Name.jpg',
            rawFileName: '08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg',
            hash: '08812a68-c09d-48a8-9b3d-e0326a25b00f',
            sourceUrl: 'https://mangadex.org/covers/770c61b9/08812a68.jpg',
            url: 'https://uploads.mangadex.org/covers/770c61b9/08812a68.jpg'
          },
          {
            filename: 'Other Manga Cover.jpg',
            rawFileName: 'other-hash.jpg',
            hash: 'other-hash',
            sourceUrl: 'https://mangadex.org/covers/other/other-hash.jpg',
            url: 'https://uploads.mangadex.org/covers/other/other-hash.jpg'
          }
        ]
      };

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') {
              return {
                files: [
                  { name: 'Custom Cover Name.jpg', path: 'C:\\library\\MangaDex\\Custom Cover Name.jpg', is_dir: false },
                  { name: 'Other Manga Cover.jpg', path: 'C:\\library\\MangaDex\\Other Manga Cover.jpg', is_dir: false },
                  { name: 'gallery.json', path: 'C:\\library\\MangaDex\\gallery.json', is_dir: false }
                ]
              };
            }
            if (cmd === 'read_text_file') {
              if (args.path === 'C:\\library\\MangaDex\\gallery.json') {
                return JSON.stringify(initialSidecar);
              }
              throw new Error('File not found');
            }
            if (cmd === 'remove_file') {
              deletedFiles.push(args.path);
              if (args.path === 'C:\\library\\MangaDex\\gallery.json') {
                sidecarDeleted = true;
              }
              return;
            }
            if (cmd === 'write_text_file') {
              if (args.path === 'C:\\library\\MangaDex\\gallery.json') {
                updatedSidecarContent = JSON.parse(args.content);
              }
              return;
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const result = {
        provider: 'MangaDex',
        cleanup: {
          removeLooseCovers: true
        },
        covers: [
          {
            hash: '08812a68-c09d-48a8-9b3d-e0326a25b00f',
            rawFileName: '08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg'
          }
        ]
      };

      await cleanupMatchingProviderEntries('C:\\library\\MangaDex', result);

      assert.deepEqual(deletedFiles, ['C:\\library\\MangaDex\\Custom Cover Name.jpg']);
      assert.equal(sidecarDeleted, false);
      assert.ok(updatedSidecarContent);
      assert.equal(updatedSidecarContent.images.length, 1);
      assert.equal(updatedSidecarContent.images[0].filename, 'Other Manga Cover.jpg');
    });

    it('findMatchingGalleryImage finds root gallery.json downloads avoiding redundant downloads', async () => {
      if (!globalThis.window) globalThis.window = {};

      const rootSidecar = {
        provider: 'MangaDex',
        isRoot: true,
        images: [
          {
            filename: 'Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg',
            rawFileName: '08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg',
            hash: '08812a68-c09d-48a8-9b3d-e0326a25b00f',
            sourceUrl: 'https://mangadex.org/covers/770c61b9/08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg',
            url: 'https://uploads.mangadex.org/covers/770c61b9/08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg'
          }
        ]
      };

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_text_file' && args.path === 'C:\\library\\MangaDex\\gallery.json') {
              return JSON.stringify(rootSidecar);
            }
            if (cmd === 'read_directory') {
              return { files: [] };
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const match = await findMatchingGalleryImage(
        'C:\\library\\MangaDex',
        'https://uploads.mangadex.org/covers/770c61b9/08812a68-c09d-48a8-9b3d-e0326a25b00f.jpg',
        '08812a68-c09d-48a8-9b3d-e0326a25b00f'
      );

      assert.ok(match);
      assert.equal(match.galleryPath, 'C:\\library\\MangaDex');
      assert.equal(match.targetName, 'Akebi-chan no Sailor Fuku - Vol. 1 Cover.jpg');
    });

    it('delegates to raw image cleanup when result is a standard gallery', async () => {
      if (!globalThis.window) globalThis.window = {};

      const deletedFiles = [];

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') {
              return {
                files: [
                  { name: '04XS16K.png', path: 'C:\\library\\Imgur\\04XS16K.png', is_dir: false },
                  { name: 'keep.png', path: 'C:\\library\\Imgur\\keep.png', is_dir: false }
                ]
              };
            }
            if (cmd === 'remove_file') {
              deletedFiles.push(args.path);
              return;
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const galleryResult = {
        provider: 'Imgur',
        images: [
          { filename: '01.png', sourceUrl: 'https://i.imgur.com/04XS16K.png' }
        ]
      };

      await cleanupMatchingProviderEntries('C:\\library\\Imgur', galleryResult);

      assert.deepEqual(deletedFiles, ['C:\\library\\Imgur\\04XS16K.png']);
    });
  });

  describe('findMatchingGalleryBySourceUrl', () => {
    it('returns null when window.__TAURI__ is missing', async () => {
      const original = globalThis.window;
      globalThis.window = undefined;
      try {
        const match = await findMatchingGalleryBySourceUrl('C:\\library\\MangaDex', 'https://mangadex.org/chapter/123');
        assert.equal(match, null);
      } finally {
        globalThis.window = original;
      }
    });

    it('finds existing gallery in nested directories by gallery id or source url', async () => {
      if (!globalThis.window) globalThis.window = {};

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') {
              if (args.path === 'C:\\library\\MangaDex') {
                return {
                  files: [
                    { name: 'Akebi-chan no Sailor Fuku', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku', is_dir: true }
                  ]
                };
              }
              if (args.path === 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku') {
                return {
                  files: [
                    { name: 'English', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku\\English', is_dir: true }
                  ]
                };
              }
              if (args.path === 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku\\English') {
                return {
                  files: [
                    { name: 'Vol. 01', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku\\English\\Vol. 01', is_dir: true }
                  ]
                };
              }
              if (args.path === 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku\\English\\Vol. 01') {
                return {
                  files: [
                    { name: 'Ch. 01', path: 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku\\English\\Vol. 01\\Ch. 01', is_dir: true }
                  ]
                };
              }
              return { files: [] };
            }
            if (cmd === 'read_text_file') {
              if (args.path === 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku\\English\\Vol. 01\\Ch. 01\\gallery.json') {
                return JSON.stringify({
                  gallery: { id: 'mangadex-0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d' },
                  sourceUrl: 'https://mangadex.org/chapter/0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d'
                });
              }
              throw new Error('Not found');
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const matchById = await findMatchingGalleryBySourceUrl(
        'C:\\library\\MangaDex',
        null,
        'mangadex-0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d'
      );
      assert.ok(matchById);
      assert.equal(matchById.galleryPath, 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku\\English\\Vol. 01\\Ch. 01');

      // The update path depends on the sidecar being returned with gallery and sourceUrl fields
      assert.ok(matchById.sidecar);
      assert.equal(matchById.sidecar.gallery.id, 'mangadex-0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d');
      assert.equal(matchById.sidecar.sourceUrl, 'https://mangadex.org/chapter/0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d');

      const matchByUrl = await findMatchingGalleryBySourceUrl(
        'C:\\library\\MangaDex',
        'https://mangadex.org/chapter/0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d'
      );
      assert.ok(matchByUrl);
      assert.equal(matchByUrl.galleryPath, 'C:\\library\\MangaDex\\Akebi-chan no Sailor Fuku\\English\\Vol. 01\\Ch. 01');

      const noMatch = await findMatchingGalleryBySourceUrl(
        'C:\\library\\MangaDex',
        'https://mangadex.org/chapter/non-existent'
      );
      assert.equal(noMatch, null);
    });

    it('returns sidecar with images array suitable for re-import update diffing', async () => {
      if (!globalThis.window) globalThis.window = {};

      const sidecarData = {
        url: 'https://imgur.com/a/test123',
        provider: 'Imgur',
        gallery: { id: 'imgur-test123', relativePath: ['Test Gallery'] },
        images: [
          { filename: '01.jpg', sourceUrl: 'https://i.imgur.com/AAA.jpg' },
          { filename: '02.jpg', sourceUrl: 'https://i.imgur.com/BBB.jpg' }
        ]
      };

      globalThis.window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'read_directory') {
              if (args.path === 'C:\\library\\Imgur') {
                return { files: [{ name: 'Test Gallery', path: 'C:\\library\\Imgur\\Test Gallery', is_dir: true }] };
              }
              return { files: [] };
            }
            if (cmd === 'read_text_file') {
              if (args.path === 'C:\\library\\Imgur\\Test Gallery\\gallery.json') {
                return JSON.stringify(sidecarData);
              }
              throw new Error('Not found');
            }
            throw new Error(`Unknown cmd ${cmd}`);
          }
        }
      };

      const match = await findMatchingGalleryBySourceUrl('C:\\library\\Imgur', 'https://imgur.com/a/test123');
      assert.ok(match);
      assert.ok(match.sidecar);
      assert.ok(Array.isArray(match.sidecar.images));
      assert.equal(match.sidecar.images.length, 2);
      assert.equal(match.sidecar.images[0].filename, '01.jpg');
      assert.equal(match.sidecar.images[1].sourceUrl, 'https://i.imgur.com/BBB.jpg');
      assert.equal(match.sidecar.gallery.id, 'imgur-test123');
    });
  });

  describe('extractUrlStem and isDirectMediaUrl', () => {
    it('extracts stems from URLs, filenames, and handles query parameters', () => {
      assert.equal(extractUrlStem('https://i.imgur.com/04XS16K.png'), '04xs16k');
      assert.equal(extractUrlStem('https://cdn.example.test/videos/sample_clip.mp4?auth=xyz#t=10'), 'sample_clip');
      assert.equal(extractUrlStem('01_sample_clip.mp4'), '01_sample_clip');
      assert.equal(extractUrlStem(''), '');
    });

    it('identifies direct media URLs across supported formats', () => {
      assert.equal(isDirectMediaUrl('https://example.test/video.mp4'), true);
      assert.equal(isDirectMediaUrl('https://example.test/photo.jpg?size=large'), true);
      assert.equal(isDirectMediaUrl('https://example.test/anim.gif'), true);
      assert.equal(isDirectMediaUrl('https://example.test/page.html'), false);
      assert.equal(isDirectMediaUrl('https://example.test/gallery/123'), false);
    });
  });

  describe('Imgur extractor audio detection', () => {
    it('preserves hasSound true/false from AJAX responses and keeps unknown mp4 audio undefined', async () => {
      const mockAjaxData = {
        data: {
          images: [
            { hash: 'vidAudio', ext: '.mp4', has_sound: true, title: 'Video With Sound' },
            { hash: 'vidSilent', ext: '.mp4', has_sound: false, title: 'Video Without Sound' },
            { hash: 'vidUnknown', ext: '.mp4', title: 'Video Unknown Audio' },
            { hash: 'staticImg', ext: '.jpg', title: 'Static Picture' }
          ]
        }
      };

      const result = await ImgurExtractor.extract(
        '<html><head><title>Test Album - Imgur</title></head><body></body></html>',
        'https://imgur.com/gallery/test123',
        {
          fetchText: async () => JSON.stringify(mockAjaxData)
        }
      );

      assert.equal(result.images.length, 4);
      assert.equal(result.images[0].hasSound, true);
      assert.equal(result.images[1].hasSound, false);
      assert.equal(result.images[2].hasSound, undefined);
      assert.equal(result.images[3].hasSound, false);
    });
  });

  describe('MangaDex extractor and manifest integration', () => {
    it('validates the live extractor manifest including mangadex', () => {
      const manifestJson = JSON.parse(fs.readFileSync('extractors/manifest.json', 'utf8'));
      const manifest = validateManifest(manifestJson);
      const mangadexEntry = manifest.extractors.find((e) => e.id === 'mangadex');
      assert.ok(mangadexEntry);
      assert.equal(mangadexEntry.name, 'MangaDex');
      assert.equal(mangadexEntry.libraryPath, 'MangaDex');
      assert.equal(mangadexEntry.source, 'mangadex.js');
    });

    it('matches MangaDex chapter, title, blob, and direct media URLs and rejects other domains', () => {
      assert.equal(MangaDexExtractor.match('https://mangadex.org/chapter/0aaf8b27-0013-4ae0-8935-91a089466874'), true);
      assert.equal(MangaDexExtractor.match('https://mangadex.org/chapter/0aaf8b27-0013-4ae0-8935-91a089466874/1'), true);
      assert.equal(MangaDexExtractor.match('https://mangadex.org/chapter/0aaf8b27-0013-4ae0-8935-91a089466874?page=2#reader'), true);
      assert.equal(MangaDexExtractor.match('https://mangadex.cc/chapter/0aaf8b27-0013-4ae0-8935-91a089466874'), true);
      assert.equal(MangaDexExtractor.match('https://mangadex.org/title/127820bd-8fc5-47b8-8782-e680317bf41d'), true);
      assert.equal(MangaDexExtractor.match('blob:https://mangadex.org/daa47d83-3e22-4bc4-86a8-7968d37cdf75'), true);
      assert.equal(MangaDexExtractor.match('https://uploads.mangadex.org/covers/127820bd-8fc5-47b8-8782-e680317bf41d/cover.jpg'), true);
      assert.equal(MangaDexExtractor.match('https://mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg'), true);
      assert.equal(MangaDexExtractor.match('https://cmdxd98sb0x3yprd.mangadex.network/data/7c07a7fecb2fe3868aa22aae2edf0e5a/1-sample.png'), true);
      assert.equal(MangaDexExtractor.match('https://example.com/chapter/0aaf8b27-0013-4ae0-8935-91a089466874'), false);
    });

    it('rejects blob URLs with a clear explanation', async () => {
      await assert.rejects(
        () => MangaDexExtractor.extract('', 'blob:https://mangadex.org/daa47d83-3e22-4bc4-86a8-7968d37cdf75'),
        /blob URLs are not supported/i
      );
    });

    it('extracts series title metadata and formats Option A chapter hierarchy with Cover.jpg', async () => {
      const mangaId = '770c61b9-0ef2-460b-8c25-c10ab23349ce';
      const mockMangaResponse = {
        result: 'ok',
        data: {
          id: mangaId,
          attributes: {
            title: { en: 'Akebi-chan no Sailor Fuku' },
            altTitles: []
          },
          relationships: [
            {
              type: 'cover_art',
              attributes: {
                volume: '16',
                fileName: '47df7fb5-dc37-492f-98bc-affe54b74960.jpg'
              }
            }
          ]
        }
      };

      const mockFeedResponse = {
        result: 'ok',
        total: 4,
        data: [
          {
            id: 'chap-0001-aaaa-bbbb-cccc-dddddddddddd',
            attributes: {
              volume: '1',
              chapter: '0',
              title: 'Prologue: A Girl Runs So Freely',
              translatedLanguage: 'en'
            },
            relationships: [
              {
                type: 'scanlation_group',
                attributes: { name: 'nojay' }
              }
            ]
          },
          {
            id: 'chap-0002-aaaa-bbbb-cccc-dddddddddddd',
            attributes: {
              volume: '1',
              chapter: '1',
              title: 'The Sailor Suit',
              translatedLanguage: 'en'
            },
            relationships: []
          },
          {
            id: 'chap-0003-aaaa-bbbb-cccc-dddddddddddd',
            attributes: {
              volume: null,
              chapter: '1',
              title: 'The Sailor Suit (Different Vol)',
              translatedLanguage: 'en'
            },
            relationships: []
          },
          {
            id: 'chap-0004-aaaa-bbbb-cccc-dddddddddddd',
            attributes: {
              volume: '1',
              chapter: '1',
              title: 'The Sailor Suit',
              translatedLanguage: 'en'
            },
            relationships: []
          }
        ]
      };

      const seriesResult = await MangaDexExtractor.extract(
        '',
        `https://mangadex.org/title/${mangaId}/akebi-chan-no-sailor-fuku`,
        {
          fetchText: async (url) => {
            if (url.includes('/manga/') && !url.includes('/feed')) {
              return JSON.stringify(mockMangaResponse);
            }
            if (url.includes('/feed')) {
              return JSON.stringify(mockFeedResponse);
            }
            throw new Error(`Unexpected URL: ${url}`);
          }
        }
      );

      assert.equal(seriesResult.provider, 'MangaDex');
      assert.equal(seriesResult.isSeries, true);
      assert.equal(seriesResult.title, 'Akebi-chan no Sailor Fuku');
      assert.deepEqual(seriesResult.rootRelativePath, ['Akebi-chan no Sailor Fuku']);
      assert.deepEqual(seriesResult.cleanup, {
        removeMatchingChapters: true,
        removeLooseCovers: false
      });
      assert.deepEqual(seriesResult.cover, {
        url: `https://uploads.mangadex.org/covers/${mangaId}/47df7fb5-dc37-492f-98bc-affe54b74960.jpg`,
        filename: 'Cover.jpg',
        rawFileName: '47df7fb5-dc37-492f-98bc-affe54b74960.jpg',
        hash: '47df7fb5-dc37-492f-98bc-affe54b74960',
        volume: '16'
      });

      assert.equal(seriesResult.chapters.length, 4);

      // Chapter 0 with group
      assert.equal(seriesResult.chapters[0].id, 'mangadex-chap-0001-aaaa-bbbb-cccc-dddddddddddd');
      assert.equal(seriesResult.chapters[0].title, 'Akebi-chan no Sailor Fuku - Vol. 1 Ch. 0 - Prologue: A Girl Runs So Freely');
      assert.equal(seriesResult.chapters[0].sourceUrl, 'https://mangadex.org/chapter/chap-0001-aaaa-bbbb-cccc-dddddddddddd');
      assert.deepEqual(seriesResult.chapters[0].relativePath, [
        'Akebi-chan no Sailor Fuku',
        'English',
        'Vol. 01',
        'Vol. 1 Ch. 0 - Prologue_ A Girl Runs So Freely [nojay]'
      ]);
      assert.notEqual(seriesResult.chapters[0].metadata, undefined);

      // Chapter 1 without group
      assert.equal(seriesResult.chapters[1].id, 'mangadex-chap-0002-aaaa-bbbb-cccc-dddddddddddd');
      assert.equal(seriesResult.chapters[1].title, 'Akebi-chan no Sailor Fuku - Vol. 1 Ch. 1 - The Sailor Suit');
      assert.equal(seriesResult.chapters[1].sourceUrl, 'https://mangadex.org/chapter/chap-0002-aaaa-bbbb-cccc-dddddddddddd');
      assert.deepEqual(seriesResult.chapters[1].relativePath, [
        'Akebi-chan no Sailor Fuku',
        'English',
        'Vol. 01',
        'Vol. 1 Ch. 1 - The Sailor Suit'
      ]);
      assert.notEqual(seriesResult.chapters[1].metadata, undefined);

      // Chapter with null volume -> 'No Volume'
      assert.deepEqual(seriesResult.chapters[2].relativePath, [
        'Akebi-chan no Sailor Fuku',
        'English',
        'No Volume',
        'Ch. 1 - The Sailor Suit (Different Vol)'
      ]);

      // Chapter with colliding path -> disambiguated with chapter ID prefix
      assert.deepEqual(seriesResult.chapters[3].relativePath, [
        'Akebi-chan no Sailor Fuku',
        'English',
        'Vol. 01',
        'Vol. 1 Ch. 1 - The Sailor Suit (chap-000)'
      ]);

      // Validate against extractor result validator
      const validated = validateExtractorResult(seriesResult, { name: 'MangaDex' });
      assert.equal(validated.isSeries, true);

      // Validate rejects invalid series results
      assert.throws(
        () => validateExtractorResult({ provider: 'MangaDex', isSeries: true, rootRelativePath: [] }),
        /rootRelativePath must be a non-empty path/
      );
      assert.throws(
        () => validateExtractorResult({ provider: 'MangaDex', isSeries: true, rootRelativePath: ['test'], chapters: 'invalid' }),
        /'chapters' must be an array/
      );
      assert.throws(
        () => validateExtractorResult({
          provider: 'MangaDex',
          isSeries: true,
          rootRelativePath: ['test'],
          chapters: [{ id: '', sourceUrl: 'https://mangadex.org', relativePath: ['a'] }]
        }),
        /missing chapter id/
      );
      assert.throws(
        () => validateExtractorResult({
          provider: 'MangaDex',
          isSeries: true,
          rootRelativePath: ['test'],
          chapters: [{ id: '1', sourceUrl: '', relativePath: ['a'] }]
        }),
        /invalid chapter sourceUrl/
      );
    });

    it('extracts chapter images and formats flat relativePath under manga title and chapter label', async () => {
      const mockChapterResponse = {
        result: 'ok',
        data: {
          id: '0aaf8b27-0013-4ae0-8935-91a089466874',
          attributes: {
            volume: '1',
            chapter: '1',
            title: '',
            externalUrl: null
          },
          relationships: [
            {
              id: '127820bd-8fc5-47b8-8782-e680317bf41d',
              type: 'manga',
              attributes: {
                title: { 'ja-ro': 'Boku wa Ohime-sama ni Narenai' }
              }
            }
          ]
        }
      };

      const mockAtHomeResponse = {
        result: 'ok',
        baseUrl: 'https://cmdxd98sb0x3yprd.mangadex.network',
        chapter: {
          hash: '7c07a7fecb2fe3868aa22aae2edf0e5a',
          data: [
            '1-fefb667afaf589128da66a6a08dfd064c39d9d4c8ed9e30512de2b75d6908c6a.png',
            '2-42ced2fe027a854e2e75ea48e4daf0243448c79b605e19e2e944d6bff14ef0aa.png'
          ]
        }
      };

      const manifestJson = JSON.parse(fs.readFileSync('extractors/manifest.json', 'utf8'));
      const mangadexEntry = manifestJson.extractors.find((e) => e.id === 'mangadex');

      // 1. Chapter URL without target page
      const result = await MangaDexExtractor.extract(
        '<meta property="og:title" content="Boku wa Ohime-sama ni Narenai - Vol. 1 Ch. 1 - MangaDex">',
        'https://mangadex.org/chapter/0aaf8b27-0013-4ae0-8935-91a089466874',
        {
          fetchText: async (url) => {
            if (url.includes('/chapter/')) return JSON.stringify(mockChapterResponse);
            if (url.includes('/at-home/server/')) return JSON.stringify(mockAtHomeResponse);
            throw new Error(`Unexpected fetch URL: ${url}`);
          }
        }
      );

      validateExtractorResult(result, mangadexEntry);

      assert.equal(result.provider, 'MangaDex');
      assert.equal(result.title, 'Boku wa Ohime-sama ni Narenai - Vol. 1 Ch. 1');
      assert.equal(result.targetFilename, null);
      assert.deepEqual(result.gallery, {
        id: 'mangadex-0aaf8b27-0013-4ae0-8935-91a089466874',
        relativePath: ['Boku wa Ohime-sama ni Narenai - Vol. 1 Ch. 1']
      });
      assert.equal(result.images.length, 2);
      assert.equal(result.images[0].filename, '01.png');
      assert.equal(result.images[1].filename, '02.png');
      assert.equal(result.images[0].url, 'https://cmdxd98sb0x3yprd.mangadex.network/data/7c07a7fecb2fe3868aa22aae2edf0e5a/1-fefb667afaf589128da66a6a08dfd064c39d9d4c8ed9e30512de2b75d6908c6a.png');

      // 2. Chapter URL with target page /2
      const resultPage2 = await MangaDexExtractor.extract(
        '<meta property="og:title" content="Boku wa Ohime-sama ni Narenai - Vol. 1 Ch. 1 - MangaDex">',
        'https://mangadex.org/chapter/0aaf8b27-0013-4ae0-8935-91a089466874/2',
        {
          fetchText: async (url) => {
            if (url.includes('/chapter/')) return JSON.stringify(mockChapterResponse);
            if (url.includes('/at-home/server/')) return JSON.stringify(mockAtHomeResponse);
            throw new Error(`Unexpected fetch URL: ${url}`);
          }
        }
      );

      assert.equal(resultPage2.targetFilename, '02.png');
    });

    it('handles external chapters, missing chapters, and empty image sets', async () => {
      // 1. External chapter
      const mockExternalChapter = {
        result: 'ok',
        data: {
          id: '11111111-2222-3333-4444-555555555555',
          attributes: { externalUrl: 'https://mangaplus.shueisha.co.jp' }
        }
      };
      await assert.rejects(
        () => MangaDexExtractor.extract('', 'https://mangadex.org/chapter/11111111-2222-3333-4444-555555555555', {
          fetchText: async () => JSON.stringify(mockExternalChapter)
        }),
        /external service/
      );

      // 2. Chapter not found
      const mockErrorChapter = {
        result: 'error',
        errors: [{ detail: 'Chapter `xyz` not found.' }]
      };
      await assert.rejects(
        () => MangaDexExtractor.extract('', 'https://mangadex.org/chapter/22222222-3333-4444-5555-666666666666', {
          fetchText: async () => JSON.stringify(mockErrorChapter)
        }),
        /Chapter `xyz` not found/
      );

      // 3. Empty image set
      const mockEmptyChapter = {
        result: 'ok',
        data: {
          id: '33333333-4444-5555-6666-777777777777',
          attributes: { chapter: '1' }
        }
      };
      const mockEmptyAtHome = {
        result: 'ok',
        baseUrl: 'https://cdn.example.test',
        chapter: { hash: 'hash123', data: [], dataSaver: [] }
      };
      await assert.rejects(
        () => MangaDexExtractor.extract('', 'https://mangadex.org/chapter/33333333-4444-5555-6666-777777777777', {
          fetchText: async (url) => {
            if (url.includes('/chapter/')) return JSON.stringify(mockEmptyChapter);
            return JSON.stringify(mockEmptyAtHome);
          }
        }),
        /No images found in chapter/
      );
    });

    it('parses direct MangaDex cover art and CDN image URLs', async () => {
      assert.equal(MangaDexExtractor.isDirectUrl('https://uploads.mangadex.org/covers/127820bd-8fc5-47b8-8782-e680317bf41d/cover.jpg'), true);
      assert.equal(MangaDexExtractor.isDirectUrl('https://mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg'), true);
      assert.equal(MangaDexExtractor.isDirectUrl('https://cmdxd98sb0x3yprd.mangadex.network/data/7c07a7fecb2fe3868aa22aae2edf0e5a/1-sample.png'), true);
      assert.equal(MangaDexExtractor.isDirectUrl('https://mangadex.org/chapter/0aaf8b27-0013-4ae0-8935-91a089466874'), false);

      const manifestJson = JSON.parse(fs.readFileSync('extractors/manifest.json', 'utf8'));
      const manifest = validateManifest(manifestJson);
      assert.equal(findExtractor('https://mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg', manifest)?.id, 'mangadex');

      // 1. Raw fallback when no context.fetchText is provided
      const coverInfo = await MangaDexExtractor.parseDirectUrl('https://uploads.mangadex.org/covers/127820bd-8fc5-47b8-8782-e680317bf41d/cover.jpg');
      assert.deepEqual(coverInfo, {
        provider: 'MangaDex',
        hash: 'cover',
        ext: '.jpg',
        filename: 'cover.jpg',
        rawFileName: 'cover.jpg',
        url: 'https://uploads.mangadex.org/covers/127820bd-8fc5-47b8-8782-e680317bf41d/cover.jpg'
      });

      // 2. Friendly filename resolution via MangaDex API
      const mockMangaResponse = {
        result: 'ok',
        data: {
          attributes: {
            title: { 'ja-ro': 'Bakemonogatari' }
          }
        }
      };
      const mockCoverResponse = {
        result: 'ok',
        data: [
          {
            attributes: {
              fileName: '03a1927d-9c79-4bc8-9d06-502cbeb408ff.jpg',
              volume: '22'
            }
          }
        ]
      };

      const resolvedCover = await MangaDexExtractor.parseDirectUrl(
        'https://mangadex.org/covers/4265c437-7d57-4d31-9b1d-0e574a07b7b7/03a1927d-9c79-4bc8-9d06-502cbeb408ff.jpg',
        {
          fetchText: async (url) => {
            if (url.includes('/manga/')) return JSON.stringify(mockMangaResponse);
            if (url.includes('/cover?')) return JSON.stringify(mockCoverResponse);
            throw new Error(`Unexpected URL: ${url}`);
          }
        }
      );

      assert.deepEqual(resolvedCover, {
        provider: 'MangaDex',
        hash: '03a1927d-9c79-4bc8-9d06-502cbeb408ff',
        ext: '.jpg',
        filename: 'Bakemonogatari - Vol. 22 Cover.jpg',
        rawFileName: '03a1927d-9c79-4bc8-9d06-502cbeb408ff.jpg',
        url: 'https://mangadex.org/covers/4265c437-7d57-4d31-9b1d-0e574a07b7b7/03a1927d-9c79-4bc8-9d06-502cbeb408ff.jpg'
      });
    });

    it('detects MangaDex art tab and locale filter in parseTitleMatch', () => {
      const match1 = MangaDexExtractor.parseTitleMatch('https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku?tab=art');
      assert.equal(match1.mangaId, '770c61b9-0ef2-460b-8c25-c10ab23349ce');
      assert.equal(match1.isArtTab, true);
      assert.equal(match1.localeFilter, null);

      const match2 = MangaDexExtractor.parseTitleMatch('https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku?tab=art&locale=ja');
      assert.equal(match2.mangaId, '770c61b9-0ef2-460b-8c25-c10ab23349ce');
      assert.equal(match2.isArtTab, true);
      assert.equal(match2.localeFilter, 'ja');

      const match3 = MangaDexExtractor.parseTitleMatch('https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku#art');
      assert.equal(match3.isArtTab, true);

      const match4 = MangaDexExtractor.parseTitleMatch('https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku#es');
      assert.equal(match4.isArtTab, true);
      assert.equal(match4.localeFilter, 'es');

      const matchNormal = MangaDexExtractor.parseTitleMatch('https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku');
      assert.equal(matchNormal.isArtTab, false);
      assert.equal(matchNormal.localeFilter, null);
    });

    it('extracts multi-locale MangaDex cover art as series shape', async () => {
      const mangaId = '770c61b9-0ef2-460b-8c25-c10ab23349ce';
      const mockManga = {
        result: 'ok',
        data: {
          id: mangaId,
          attributes: { title: { en: 'Akebi-chan no Sailor Fuku' } }
        }
      };
      const mockCovers = {
        result: 'ok',
        total: 3,
        data: [
          {
            id: 'cov-1',
            attributes: { volume: '1', locale: 'ja', fileName: 'hash1.jpg' }
          },
          {
            id: 'cov-2',
            attributes: { volume: '2', locale: 'ja', fileName: 'hash2.jpg' }
          },
          {
            id: 'cov-3',
            attributes: { volume: '1', locale: 'es', fileName: 'hash3.jpg' }
          }
        ]
      };

      const result = await MangaDexExtractor.extract(
        '',
        `https://mangadex.org/title/${mangaId}/akebi-chan-no-sailor-fuku?tab=art`,
        {
          fetchText: async (url) => {
            if (url.includes('/manga/')) return JSON.stringify(mockManga);
            if (url.includes('/cover?')) return JSON.stringify(mockCovers);
            throw new Error(`Unexpected URL: ${url}`);
          }
        }
      );

      assert.equal(result.provider, 'MangaDex');
      assert.equal(result.isSeries, true);
      assert.equal(result.title, 'Akebi-chan no Sailor Fuku (Covers)');
      assert.deepEqual(result.rootRelativePath, ['Akebi-chan no Sailor Fuku (Covers)']);
      assert.notEqual(result.cover, null);
      assert.equal(result.cover.filename, 'Cover.jpg');
      assert.equal(result.covers.length, 3);
      assert.deepEqual(result.cleanup, {
        removeMatchingChapters: false,
        removeLooseCovers: true
      });
      assert.equal(result.chapters.length, 2);
      assert.equal(result.chapters[0].id, `mangadex-${mangaId}-covers-ja`);
      assert.equal(result.chapters[0].title, 'Akebi-chan no Sailor Fuku - Covers (Japanese)');
      assert.equal(result.chapters[0].sourceUrl, `https://mangadex.org/title/${mangaId}?tab=art&locale=ja`);
      assert.deepEqual(result.chapters[0].relativePath, ['Akebi-chan no Sailor Fuku (Covers)', 'Japanese']);
      assert.notEqual(result.chapters[0].metadata, undefined);
      assert.equal(result.chapters[0].metadata.ComicInfo.LanguageISO, 'ja');
      assert.equal(result.chapters[0].metadata.ComicInfo.PageCount, 2);

      assert.equal(result.chapters[1].id, `mangadex-${mangaId}-covers-es`);
      assert.equal(result.chapters[1].title, 'Akebi-chan no Sailor Fuku - Covers (Spanish)');
      assert.equal(result.chapters[1].sourceUrl, `https://mangadex.org/title/${mangaId}?tab=art&locale=es`);
      assert.deepEqual(result.chapters[1].relativePath, ['Akebi-chan no Sailor Fuku (Covers)', 'Spanish']);
      assert.notEqual(result.chapters[1].metadata, undefined);
      assert.equal(result.chapters[1].metadata.ComicInfo.LanguageISO, 'es');
      assert.equal(result.chapters[1].metadata.ComicInfo.PageCount, 1);
    });

    it('extracts single-locale MangaDex cover art as gallery with clean volume names, bracketed descriptions, and URL sanitization', async () => {
      const mangaId = '770c61b9-0ef2-460b-8c25-c10ab23349ce';
      const mockManga = {
        result: 'ok',
        data: {
          id: mangaId,
          attributes: { title: { en: 'Akebi-chan no Sailor Fuku' } }
        }
      };
      const mockCovers = {
        result: 'ok',
        total: 4,
        data: [
          {
            id: 'cov-1',
            attributes: { volume: '1', locale: 'ja', fileName: 'vol1.jpg', description: '' }
          },
          {
            id: 'cov-2',
            attributes: { volume: '2', locale: 'ja', fileName: 'vol2_special.jpg', description: 'Special Edition' }
          },
          {
            id: 'cov-3',
            attributes: { volume: null, locale: 'ja', fileName: 'extra.jpg', description: 'Bonus Art' }
          },
          {
            id: 'cov-4',
            attributes: { volume: '10', locale: 'ja', fileName: 'vol10.jpg', description: 'https://twitter.com/author/status/123' }
          }
        ]
      };

      const result = await MangaDexExtractor.extract(
        '',
        `https://mangadex.org/title/${mangaId}/akebi-chan-no-sailor-fuku?tab=art&locale=ja`,
        {
          fetchText: async (url) => {
            if (url.includes('/manga/')) return JSON.stringify(mockManga);
            if (url.includes('/cover?')) return JSON.stringify(mockCovers);
            throw new Error(`Unexpected URL: ${url}`);
          }
        }
      );

      assert.equal(result.provider, 'MangaDex');
      assert.equal(result.isSeries, undefined);
      assert.equal(result.title, 'Akebi-chan no Sailor Fuku - Covers (Japanese)');
      assert.deepEqual(result.gallery, {
        id: `mangadex-${mangaId}-covers-ja`,
        relativePath: ['Akebi-chan no Sailor Fuku (Covers)', 'Japanese']
      });
      assert.equal(result.images.length, 4);

      // Volume 1: zero-padded to 2 digits, no description
      assert.equal(result.images[0].filename, 'Vol. 01.jpg');
      assert.equal(result.images[0].description, 'Volume 1');

      // Volume 2: bracketed description
      assert.equal(result.images[1].filename, 'Vol. 02 [Special Edition].jpg');
      assert.equal(result.images[1].description, 'Special Edition');

      // Volume 10: URL in description is sanitized out of filename, preserved in description
      assert.equal(result.images[2].filename, 'Vol. 10.jpg');
      assert.equal(result.images[2].description, 'https://twitter.com/author/status/123');

      // Null volume: Extra [Bonus Art]
      assert.equal(result.images[3].filename, 'Extra [Bonus Art].jpg');
      assert.equal(result.images[3].description, 'Bonus Art');

      // Disambiguation of collisions
      const mockCollisions = {
        result: 'ok',
        total: 2,
        data: [
          { id: 'c1', attributes: { volume: '1', locale: 'ja', fileName: 'aaaa1111-bbbb.jpg' } },
          { id: 'c2', attributes: { volume: '1', locale: 'ja', fileName: 'cccc2222-dddd.jpg' } }
        ]
      };
      const collisionResult = await MangaDexExtractor.extract(
        '',
        `https://mangadex.org/title/${mangaId}/akebi-chan-no-sailor-fuku?tab=art&locale=ja`,
        {
          fetchText: async (url) => {
            if (url.includes('/manga/')) return JSON.stringify(mockManga);
            if (url.includes('/cover?')) return JSON.stringify(mockCollisions);
            throw new Error(`Unexpected URL: ${url}`);
          }
        }
      );
      assert.equal(collisionResult.images[0].filename, 'Vol. 01.jpg');
      assert.equal(collisionResult.images[1].filename, 'Vol. 01 (cccc2222).jpg');
    });
  });

  describe('writeGalleryMetadata and generic extractor metadata contract', () => {
    it('validates extractor metadata shape and rejects unsafe metadata properties', () => {
      // Valid metadata object
      assert.doesNotThrow(() => {
        validateExtractorResult({
          provider: 'MangaDex',
          gallery: { id: 'test', relativePath: ['test'] },
          images: [{ url: 'https://example.com/1.jpg', filename: '1.jpg' }],
          metadata: { ComicInfo: { Title: 'Test' } }
        });
      });

      // Valid metadata string
      assert.doesNotThrow(() => {
        validateExtractorResult({
          provider: 'MangaDex',
          gallery: { id: 'test', relativePath: ['test'] },
          images: [{ url: 'https://example.com/1.jpg', filename: '1.jpg' }],
          metadata: '<ComicInfo><Title>Test</Title></ComicInfo>'
        });
      });

      // Invalid metadata type (number)
      assert.throws(() => {
        validateExtractorResult({
          provider: 'MangaDex',
          gallery: { id: 'test', relativePath: ['test'] },
          images: [{ url: 'https://example.com/1.jpg', filename: '1.jpg' }],
          metadata: 12345
        });
      }, /'metadata' must be an object or string/);

      // Unsafe metadata filename
      assert.throws(() => {
        validateExtractorResult({
          provider: 'MangaDex',
          gallery: { id: 'test', relativePath: ['test'] },
          images: [{ url: 'https://example.com/1.jpg', filename: '1.jpg' }],
          metadata: { filename: '..\\traversal.json', content: '{}' }
        });
      }, /unsafe metadata filename/);

      // Unsafe chapter metadata filename
      assert.throws(() => {
        validateExtractorResult({
          provider: 'MangaDex',
          isSeries: true,
          rootRelativePath: ['Series'],
          chapters: [{
            id: 'ch-1',
            title: 'Ch 1',
            sourceUrl: 'https://mangadex.org/chapter/1',
            relativePath: ['Series', 'Ch 1'],
            metadata: { filename: 'COM1', content: '{}' }
          }]
        });
      }, /unsafe chapter metadata filename/);

      // Valid folders array
      assert.doesNotThrow(() => {
        validateExtractorResult({
          provider: 'MangaDex',
          isSeries: true,
          rootRelativePath: ['Series'],
          folders: [{
            relativePath: ['Series', 'English'],
            metadata: { ComicInfo: { Title: 'Series (English)' } }
          }],
          chapters: []
        });
      });

      // Invalid folders type (not array)
      assert.throws(() => {
        validateExtractorResult({
          provider: 'MangaDex',
          isSeries: true,
          rootRelativePath: ['Series'],
          folders: 'not-an-array',
          chapters: []
        });
      }, /'folders' must be an array/);

      // Unsafe folder path segment
      assert.throws(() => {
        validateExtractorResult({
          provider: 'MangaDex',
          isSeries: true,
          rootRelativePath: ['Series'],
          folders: [{
            relativePath: ['Series', '..'],
            metadata: {}
          }],
          chapters: []
        });
      }, /unsafe folder relativePath segment/);

      // Unsafe folder metadata filename
      assert.throws(() => {
        validateExtractorResult({
          provider: 'MangaDex',
          isSeries: true,
          rootRelativePath: ['Series'],
          folders: [{
            relativePath: ['Series', 'English'],
            metadata: { filename: 'NUL', content: '{}' }
          }],
          chapters: []
        });
      }, /unsafe folder metadata filename/);
    });

    it('writes comicinfo.json for structured metadata object', async () => {
      const written = [];
      const origInvoke = window.__TAURI__?.core?.invoke;
      if (!window.__TAURI__) {
        globalThis.window = { __TAURI__: { core: {} } };
      }
      window.__TAURI__.core.invoke = async (cmd, args) => {
        if (cmd === 'write_text_file') {
          written.push(args);
          return;
        }
        if (origInvoke) return origInvoke(cmd, args);
      };

      try {
        await writeGalleryMetadata('C:\\Library\\MangaDex\\Series', {
          ComicInfo: { Title: 'Series Name', Writer: 'Author' }
        });

        assert.equal(written.length, 1);
        assert.equal(written[0].path, 'C:\\Library\\MangaDex\\Series\\comicinfo.json');
        const parsed = JSON.parse(written[0].content);
        assert.equal(parsed.ComicInfo.Title, 'Series Name');
        assert.equal(parsed.ComicInfo.Writer, 'Author');
      } finally {
        if (origInvoke) window.__TAURI__.core.invoke = origInvoke;
      }
    });

    it('writes comicinfo.xml for XML string and custom filename when specified', async () => {
      const written = [];
      const origInvoke = window.__TAURI__?.core?.invoke;
      if (!window.__TAURI__) {
        globalThis.window = { __TAURI__: { core: {} } };
      }
      window.__TAURI__.core.invoke = async (cmd, args) => {
        if (cmd === 'write_text_file') {
          written.push(args);
          return;
        }
        if (origInvoke) return origInvoke(cmd, args);
      };

      try {
        // XML string -> comicinfo.xml
        await writeGalleryMetadata('C:\\Library\\MangaDex\\Series', '<?xml version="1.0"?><ComicInfo></ComicInfo>');
        assert.equal(written.length, 1);
        assert.equal(written[0].path, 'C:\\Library\\MangaDex\\Series\\comicinfo.xml');

        // Custom filename and content
        await writeGalleryMetadata('C:\\Library\\MangaDex\\Series', {
          filename: 'metadata.opf',
          content: '<package></package>'
        });
        assert.equal(written.length, 2);
        assert.equal(written[1].path, 'C:\\Library\\MangaDex\\Series\\metadata.opf');
        assert.equal(written[1].content, '<package></package>');

        // No-ops on null or empty
        await writeGalleryMetadata(null, { test: 1 });
        await writeGalleryMetadata('C:\\test', null);
        assert.equal(written.length, 2);
      } finally {
        if (origInvoke) window.__TAURI__.core.invoke = origInvoke;
      }
    });

    it('MangaDex standalone chapter extraction returns ComicInfo metadata with chapter title and scanlator', async () => {
      const chapterId = '0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d';
      const mangaId = '770c61b9-0ef2-460b-8c25-c10ab23349ce';

      const mockChapter = {
        result: 'ok',
        data: {
          id: chapterId,
          attributes: {
            volume: '1',
            chapter: '1',
            title: 'First Day',
            translatedLanguage: 'en',
            hash: 'ch-hash-123',
            data: ['01.jpg', '02.jpg']
          },
          relationships: [
            { id: mangaId, type: 'manga' },
            { id: 'group-1', type: 'scanlation_group', attributes: { name: 'Scan Team' } }
          ]
        }
      };

      const mockManga = {
        result: 'ok',
        data: {
          id: mangaId,
          attributes: {
            title: { en: 'Akebi-chan no Sailor Fuku' },
            publicationDemographic: 'seinen',
            tags: [
              { attributes: { group: 'genre', name: { en: 'Comedy' } } },
              { attributes: { group: 'theme', name: { en: 'School Life' } } }
            ],
            description: { en: 'A slice of life manga.' }
          },
          relationships: [
            { type: 'author', attributes: { name: 'HIRO' } },
            { type: 'artist', attributes: { name: 'HIRO' } }
          ]
        }
      };

      const mockAtHome = {
        result: 'ok',
        baseUrl: 'https://uploads.mangadex.org',
        chapter: { hash: 'ch-hash-123', data: ['01.jpg', '02.jpg'] }
      };

      const result = await MangaDexExtractor.extract(
        '',
        `https://mangadex.org/chapter/${chapterId}`,
        {
          fetchText: async (url) => {
            if (url.includes('/chapter/')) return JSON.stringify(mockChapter);
            if (url.includes('/manga/')) return JSON.stringify(mockManga);
            if (url.includes('/at-home/')) return JSON.stringify(mockAtHome);
            throw new Error(`Unexpected URL: ${url}`);
          }
        }
      );

      assert.equal(result.provider, 'MangaDex');
      assert.notEqual(result.metadata, null);
      const comicInfo = result.metadata.ComicInfo;
      assert.equal(comicInfo.Series, 'Akebi-chan no Sailor Fuku');
      assert.equal(comicInfo.Title, 'Ch. 1 - First Day');
      assert.equal(comicInfo.Writer, 'HIRO');
      assert.equal(comicInfo.Penciller, 'HIRO');
      assert.equal(comicInfo.Genre, 'Comedy');
      assert.equal(comicInfo.Tags, 'Seinen, School Life');
      assert.equal(comicInfo.Demographic, 'Seinen');
      assert.equal(comicInfo.Number, '1');
      assert.equal(comicInfo.Volume, '1');
      assert.equal(comicInfo.Translator, 'Scan Team');
      assert.equal(comicInfo.Notes, 'Scanlation: Scan Team');
      assert.equal(comicInfo.LanguageISO, 'en');
      assert.equal(comicInfo.PageCount, 2);
      assert.equal(comicInfo.Web, `https://mangadex.org/chapter/${chapterId}`);
    });

    it('MangaDex series extraction produces 5-tier folder metadata matching the exact field specification', async () => {
      const mangaId = '770c61b9-0ef2-460b-8c25-c10ab23349ce';
      const mockManga = {
        result: 'ok',
        data: {
          id: mangaId,
          attributes: {
            title: { en: 'Akebi-chan no Sailor Fuku' },
            publicationDemographic: 'seinen',
            status: 'ongoing',
            year: 2016,
            tags: [
              { attributes: { group: 'genre', name: { en: 'Comedy' } } }
            ],
            description: { en: 'Series synopsis.' }
          },
          relationships: [
            { type: 'author', attributes: { name: 'HIRO' } },
            { type: 'artist', attributes: { name: 'HIRO' } }
          ]
        }
      };

      const mockFeed = {
        result: 'ok',
        total: 1,
        data: [
          {
            id: 'ch-1',
            attributes: {
              volume: '1',
              chapter: '1',
              title: 'First Day',
              translatedLanguage: 'en',
              pages: 24
            },
            relationships: [
              { type: 'scanlation_group', attributes: { name: 'Scan Team' } }
            ]
          }
        ]
      };

      const result = await MangaDexExtractor.extract(
        '',
        `https://mangadex.org/title/${mangaId}`,
        {
          fetchText: async (url) => {
            if (url.includes('/feed?')) return JSON.stringify(mockFeed);
            if (url.includes('/manga/')) return JSON.stringify(mockManga);
            throw new Error(`Unexpected URL: ${url}`);
          }
        }
      );

      assert.equal(result.isSeries, true);
      assert.equal(result.title, 'Akebi-chan no Sailor Fuku');

      // 1. Series Root {Series}/
      const rootMeta = result.metadata.ComicInfo;
      assert.equal(rootMeta.Series, 'Akebi-chan no Sailor Fuku');
      assert.equal(rootMeta.Title, undefined);
      assert.equal(rootMeta.Volume, undefined);
      assert.equal(rootMeta.Number, undefined);
      assert.equal(rootMeta.LanguageISO, undefined);
      assert.equal(rootMeta.Translator, undefined);
      assert.equal(rootMeta.Notes, undefined);
      assert.equal(rootMeta.PageCount, undefined);
      assert.equal(rootMeta.Web, `https://mangadex.org/title/${mangaId}`);
      assert.equal(rootMeta.Summary, 'Series synopsis.');
      assert.equal(rootMeta.Genre, 'Comedy');
      assert.equal(rootMeta.Demographic, 'Seinen');
      assert.equal(rootMeta.Writer, 'HIRO');
      assert.equal(rootMeta.Penciller, 'HIRO');
      assert.equal(rootMeta.Year, 2016);
      assert.equal(rootMeta.Status, 'Ongoing');
      assert.equal(rootMeta.Manga, 'YesAndRightToLeft');

      // 2. Language Folder {Series}/{Lang}/
      const langFolder = result.folders.find(f => f.relativePath.length === 2 && f.relativePath[1] === 'English');
      assert.notEqual(langFolder, undefined);
      const langMeta = langFolder.metadata.ComicInfo;
      assert.equal(langMeta.Series, 'Akebi-chan no Sailor Fuku');
      assert.equal(langMeta.Title, 'Akebi-chan no Sailor Fuku (English)');
      assert.equal(langMeta.LanguageISO, 'en');
      assert.equal(langMeta.Volume, undefined);
      assert.equal(langMeta.Number, undefined);
      assert.equal(langMeta.Translator, undefined);
      assert.equal(langMeta.Notes, undefined);
      assert.equal(langMeta.PageCount, undefined);
      assert.equal(langMeta.Web, `https://mangadex.org/title/${mangaId}`);
      assert.equal(langMeta.Summary, 'Series synopsis.');

      // 3. Volume Folder .../Vol. {X}/
      const volFolder = result.folders.find(f => f.relativePath.length === 3 && f.relativePath[2] === 'Vol. 01');
      assert.notEqual(volFolder, undefined);
      const volMeta = volFolder.metadata.ComicInfo;
      assert.equal(volMeta.Series, 'Akebi-chan no Sailor Fuku');
      assert.equal(volMeta.Title, 'Volume 1');
      assert.equal(volMeta.Volume, '1');
      assert.equal(volMeta.LanguageISO, 'en');
      assert.equal(volMeta.Number, undefined);
      assert.equal(volMeta.Translator, undefined);
      assert.equal(volMeta.Notes, undefined);
      assert.equal(volMeta.PageCount, undefined);
      assert.equal(volMeta.Web, `https://mangadex.org/title/${mangaId}`);

      // 4. Chapter Folder .../Ch. {Y}/
      assert.equal(result.chapters.length, 1);
      const chMeta = result.chapters[0].metadata.ComicInfo;
      assert.equal(chMeta.Series, 'Akebi-chan no Sailor Fuku');
      assert.equal(chMeta.Title, 'Ch. 1 - First Day');
      assert.equal(chMeta.Volume, '1');
      assert.equal(chMeta.Number, '1');
      assert.equal(chMeta.LanguageISO, 'en');
      assert.equal(chMeta.Translator, 'Scan Team');
      assert.equal(chMeta.Notes, 'Scanlation: Scan Team');
      assert.equal(chMeta.PageCount, 24);
      assert.equal(chMeta.Web, 'https://mangadex.org/chapter/ch-1');

      // 5. Art Collection {Series} (Covers)/
      const mockCovers = {
        result: 'ok',
        total: 1,
        data: [
          {
            attributes: { fileName: 'cover1.jpg', volume: '1', locale: 'ja' }
          }
        ]
      };
      const artResult = await MangaDexExtractor.extract(
        '',
        `https://mangadex.org/title/${mangaId}#art`,
        {
          fetchText: async (url) => {
            if (url.includes('/cover?')) return JSON.stringify(mockCovers);
            if (url.includes('/manga/')) return JSON.stringify(mockManga);
            throw new Error(`Unexpected URL: ${url}`);
          }
        }
      );
      const rootArtMeta = (artResult.folders && artResult.folders[0]?.metadata)
        ? artResult.folders[0].metadata.ComicInfo
        : artResult.metadata.ComicInfo;
      assert.equal(rootArtMeta.Series, 'Akebi-chan no Sailor Fuku');
      assert.equal(rootArtMeta.Title, 'Akebi-chan no Sailor Fuku (Covers)');
      assert.equal(rootArtMeta.Summary, 'Cover art collection for Akebi-chan no Sailor Fuku.');
      assert.equal(rootArtMeta.Tags, 'Cover Gallery, Artbook');
      assert.equal(rootArtMeta.Volume, undefined);
      assert.equal(rootArtMeta.Number, undefined);
      assert.equal(rootArtMeta.LanguageISO, undefined);
      assert.equal(rootArtMeta.Translator, undefined);
      assert.equal(rootArtMeta.Notes, undefined);
      assert.equal(rootArtMeta.PageCount, undefined);
      assert.equal(rootArtMeta.Web, `https://mangadex.org/title/${mangaId}#art`);

      const localeArtMeta = artResult.metadata.ComicInfo;
      assert.equal(localeArtMeta.Title, 'Akebi-chan no Sailor Fuku - Covers (Japanese)');
      assert.equal(localeArtMeta.LanguageISO, 'ja');
      assert.equal(localeArtMeta.PageCount, 1);
    });

    it('MangaDex direct covers do not produce metadata sidecar to prevent root collisions', async () => {
      const mangaId = '770c61b9-0ef2-460b-8c25-c10ab23349ce';
      const result = await MangaDexExtractor.extract(
        '',
        `https://mangadex.org/covers/${mangaId}/cover123.jpg`,
        {
          fetchText: async () => JSON.stringify({ data: { attributes: { title: { en: 'Direct Cover' } } } })
        }
      );

      assert.equal(result.provider, 'MangaDex');
      assert.equal(result.metadata, undefined);
    });
  });
});


import * as KMangaExtractor from '../extractors/kmanga.js';
import * as DirectExtractor from '../extractors/direct.js';
import {
  buildKmangaHash,
  buildTileOrder,
  parseKmangaEpisodeUrl,
  parseKmangaEpisodeId,
  cleanKmangaUrl,
  buildKmangaImages,
  parseNuxtData
} from '../extractors/shared/kmanga.js';

describe('K-Manga extractor', () => {
  describe('URL matching', () => {
    it('matches episode, title, and CDN URLs and rejects other domains', () => {
      assert.equal(KMangaExtractor.match('https://kmanga.kodansha.com/title/10072/episode/311334'), true);
      assert.equal(KMangaExtractor.match('https://kmanga.kodansha.com/title/10072'), true);
      assert.equal(KMangaExtractor.match('https://cdn.kmanga.kodansha.com/path/to/image.jpg?token=abc'), true);
      assert.equal(KMangaExtractor.match('https://example.com/title/10072'), false);
      assert.equal(KMangaExtractor.match(''), false);
      assert.equal(KMangaExtractor.match(null), false);
    });

    it('identifies and parses direct CDN image URLs', async () => {
      assert.equal(KMangaExtractor.isDirectUrl('https://cdn.kmanga.kodansha.com/path/to/image.jpg?token=abc'), true);
      assert.equal(KMangaExtractor.isDirectUrl('https://kmanga.kodansha.com/title/10072'), false);

      const parsed = await KMangaExtractor.parseDirectUrl('https://cdn.kmanga.kodansha.com/path/to/image.jpg?token=abc');
      assert.equal(parsed.provider, 'K MANGA');
      assert.ok(parsed.filename.endsWith('.jpg'));
      assert.equal(parsed.url, 'https://cdn.kmanga.kodansha.com/path/to/image.jpg?token=abc');

      assert.equal(await KMangaExtractor.parseDirectUrl('https://example.com/image.jpg'), null);
    });
  });

  describe('shared/kmanga.js helpers', () => {
    it('parses episode URLs and extracts episode ids', () => {
      const parsed = parseKmangaEpisodeUrl('https://kmanga.kodansha.com/title/10072/episode/311334');
      assert.deepEqual(parsed, { titleId: 10072, episodeId: 311334 });
      assert.equal(parseKmangaEpisodeId('https://kmanga.kodansha.com/title/10072/episode/311334'), 311334);
      assert.equal(parseKmangaEpisodeId('https://example.com/episode/311334'), null);
    });

    it('cleans K-Manga URLs to canonical form', () => {
      assert.equal(
        cleanKmangaUrl('https://kmanga.kodansha.com/title/10072/episode/311334?utm_source=mangadex'),
        'https://kmanga.kodansha.com/title/10072/episode/311334'
      );
      assert.equal(cleanKmangaUrl('https://example.com/page'), null);
    });

    it('computes hash digest matching the recorded 311334 vector', async () => {
      const hash = await buildKmangaHash({ episode_id: 311334 }, '1999-01', 1821414265);
      assert.equal(typeof hash, 'string');
      assert.equal(hash.length, 128);
      assert.equal(hash, '0f195833a0ec17653a6891abc9c95fc0cd26838a9f2405c7fa4cd4a8e5fd592951c792cd2b45813391e90be89f113ca5c3e5c7ff9d25382eb5cd4964ba3b0147');
    });

    it('produces a valid tile order permutation', () => {
      const order = buildTileOrder('r7yw738iu3', 10072, 311334, 4, 4);
      assert.equal(order.length, 16);
      assert.deepEqual(order, [12, 5, 13, 6, 7, 10, 3, 1, 9, 14, 8, 2, 4, 0, 11, 15]);
      const sorted = [...order].sort((a, b) => a - b);
      assert.deepEqual(sorted, Array.from({ length: 16 }, (_, i) => i));
    });

    it('builds image array with descramble descriptors', () => {
      const pages = [
        'https://cdn.kmanga.kodansha.com/page/001.jpg?token=abc',
        'https://cdn.kmanga.kodansha.com/page/002.jpg?token=def'
      ];
      const images = buildKmangaImages(pages, 'seed123', 10072, 311334);
      assert.equal(images.length, 2);
      assert.equal(images[0].filename, '01.jpg');
      assert.equal(images[1].filename, '02.jpg');
      assert.equal(images[0].url, pages[0]);
      assert.deepEqual(images[0].descramble.algorithm, 'tile-grid');
      assert.equal(images[0].descramble.cols, 4);
      assert.equal(images[0].descramble.rows, 4);
      assert.equal(images[0].descramble.order.length, 16);
    });

    it('parses NUXT_DATA from HTML', () => {
      const html = '<script id="__NUXT_DATA__">[{"title_name":"Test Manga","episode_id_list":[1,2,3],"author_text":"Author"}]</script>';
      const data = parseNuxtData(html);
      assert.ok(Array.isArray(data));
      assert.equal(data[0].title_name, 'Test Manga');
    });
  });

  describe('kmanga author and genre metadata', () => {
    it('splits Manga/Story roles into penciller and writer', () => {
      assert.deepEqual(
        KMangaExtractor.parseKmangaAuthors('Manga by Mitsuru Hattori Story by NISIOISIN'),
        { writer: 'NISIOISIN', penciller: 'Mitsuru Hattori' }
      );
    });

    it('folds character design into the penciller credit', () => {
      assert.deepEqual(
        KMangaExtractor.parseKmangaAuthors('Story by Nekoko Manga by BroccoLee Character Design by Jaian'),
        { writer: 'Nekoko', penciller: 'BroccoLee, Jaian' }
      );
    });

    it('fills both credits for a bare creator name', () => {
      assert.deepEqual(
        KMangaExtractor.parseKmangaAuthors('Kamome Shirahama'),
        { writer: 'Kamome Shirahama', penciller: 'Kamome Shirahama' }
      );
    });

    it('returns empty credits for missing author text', () => {
      assert.deepEqual(KMangaExtractor.parseKmangaAuthors(''), { writer: '', penciller: '' });
      assert.deepEqual(KMangaExtractor.parseKmangaAuthors(null), { writer: '', penciller: '' });
    });

    it('maps genre ids to catalog names kept intact on every tier', async () => {      const html = '<html><script id="__NUXT_DATA__">[{"title_name":"Exiled Heavy Knight","episode_id_list":[100],"free_episode_count":3,"author_text":"Story by Nekoko Manga by BroccoLee Character Design by Jaian","synopsis":"Isekai story.","title_grid_wide":"https://cdn.kmanga.kodansha.com/cover.jpg","genre_id_list":[9,15]},{"genre_list":[{"genre_id":9,"genre_name":"Isekai･Super Powers"},{"genre_id":15,"genre_name":"Anime"}]}]</script></html>';

      const result = await KMangaExtractor.extract(
        html,
        'https://kmanga.kodansha.com/title/10577',
        {
          fetchText: async () => JSON.stringify({
            episode: { episode_id: 100, episode_name: '156', point: 0 }
          })
        }
      );

      assert.equal(result.metadata.ComicInfo.Writer, 'Nekoko');
      assert.equal(result.metadata.ComicInfo.Penciller, 'BroccoLee, Jaian');
      assert.equal(result.metadata.ComicInfo.Genre, 'Isekai･Super Powers, Anime');
      assert.equal(result.chapters[0].metadata.ComicInfo.Writer, 'Nekoko');
      assert.equal(result.chapters[0].metadata.ComicInfo.Penciller, 'BroccoLee, Jaian');
      assert.equal(result.chapters[0].metadata.ComicInfo.Genre, 'Isekai･Super Powers, Anime');
      assert.equal(result.chapters[0].metadata.ComicInfo.Summary, 'Isekai story.');
    });

    it('moves trailing edition credits from synopsis to notes', async () => {
      const html = '<html><script id="__NUXT_DATA__">[{"title_name":"Imperfect Girl","episode_id_list":[100],"free_episode_count":3,"author_text":"Manga by Mitsuru Hattori Story by NISIOISIN","introduction_text":"Thank that girl ...\\" \\" Translation by Ko Ransom, Lettering by Grace Lu/Anthony Quintessenza, Kodansha USA Publishing, LLC","title_grid_wide":"https://cdn.kmanga.kodansha.com/cover.jpg"}]</script></html>';

      const result = await KMangaExtractor.extract(
        html,
        'https://kmanga.kodansha.com/title/10207',
        {
          fetchText: async () => JSON.stringify({
            episode: { episode_id: 100, episode_name: '1', point: 0 }
          })
        }
      );

      assert.equal(result.metadata.ComicInfo.Summary, 'Thank that girl ..."');
      assert.equal(
        result.metadata.ComicInfo.Notes,
        'Translation by Ko Ransom, Lettering by Grace Lu/Anthony Quintessenza, Kodansha USA Publishing, LLC'
      );
      assert.equal(result.chapters[0].metadata.ComicInfo.Summary, 'Thank that girl ..."');
      assert.equal(
        result.chapters[0].metadata.ComicInfo.Notes,
        'Translation by Ko Ransom, Lettering by Grace Lu/Anthony Quintessenza, Kodansha USA Publishing, LLC'
      );
    });

    it('keeps pipe-joined dual edition credits intact in notes', async () => {
      const html = '<html><script id="__NUXT_DATA__">[{"title_name":"BAKEMONOGATARI","episode_id_list":[100],"free_episode_count":3,"author_text":"Manga by Oh!Great Story by NISIOISIN","introduction_text":"Everywhere. \\" Translation by Ko Ransom, Kodansha USA Publishing, LLC | Translation by Ella Donaldson, YKS Services LLC/SKY JAPAN, Inc.","title_grid_wide":"https://cdn.kmanga.kodansha.com/cover.jpg"}]</script></html>';

      const result = await KMangaExtractor.extract(
        html,
        'https://kmanga.kodansha.com/title/10072',
        {
          fetchText: async () => JSON.stringify({
            episode: { episode_id: 100, episode_name: '1', point: 0 }
          })
        }
      );

      assert.equal(result.metadata.ComicInfo.Summary, 'Everywhere.');
      assert.equal(
        result.metadata.ComicInfo.Notes,
        'Translation by Ko Ransom, Kodansha USA Publishing, LLC | Translation by Ella Donaldson, YKS Services LLC/SKY JAPAN, Inc.'
      );
      assert.equal(
        result.chapters[0].metadata.ComicInfo.Notes,
        'Translation by Ko Ransom, Kodansha USA Publishing, LLC | Translation by Ella Donaldson, YKS Services LLC/SKY JAPAN, Inc.'
      );
    });

    it('leaves synopses without a credit block untouched', async () => {
      const html = '<html><script id="__NUXT_DATA__">[{"title_name":"Sakura","episode_id_list":[100],"free_episode_count":3,"author_text":"Fuyu Yukimiya","introduction_text":"Honest dedication?\\"","title_grid_wide":"https://cdn.kmanga.kodansha.com/cover.jpg"}]</script></html>';

      const result = await KMangaExtractor.extract(
        html,
        'https://kmanga.kodansha.com/title/10454',
        {
          fetchText: async () => JSON.stringify({
            episode: { episode_id: 100, episode_name: '1', point: 0 }
          })
        }
      );

      assert.equal(result.metadata.ComicInfo.Summary, 'Honest dedication?"');
      assert.equal(result.metadata.ComicInfo.Notes, undefined);
      assert.equal(result.chapters[0].metadata.ComicInfo.Notes, undefined);
    });
  });

  describe('episode extraction', () => {
    it('extracts episode with descramble descriptors and metadata', async () => {
      const html = '<html><script id="__NUXT_DATA__">[{"title_name":"Attack on Titan","episode_id_list":[311334,311335],"author_text":"Hajime Isayama","synopsis":"A story about titans.","title_grid_wide":"https://cdn.kmanga.kodansha.com/cover.jpg"},{"episode_id":311334,"episode_name":"01","thumbnail_image_url":"https://cdn.kmanga.kodansha.com/thumb/ep311334.png"}]</script></html>';
      const viewerResponse = {
        data: {
          viewer_pages: {
            scramble_seed: 'r7yw738iu3',
            page_list: [
              { src: 'https://cdn.kmanga.kodansha.com/page/001.jpg?token=abc' },
              { src: 'https://cdn.kmanga.kodansha.com/page/002.jpg?token=def' }
            ],
            next_episode: { episode_id: 311335 }
          }
        }
      };

      const result = await KMangaExtractor.extract(
        html,
        'https://kmanga.kodansha.com/title/10072/episode/311334',
        {
          fetchText: async () => JSON.stringify(viewerResponse)
        }
      );

      assert.equal(result.provider, 'K MANGA');
      assert.equal(result.title, 'Attack on Titan - Ch. 01');
      assert.equal(result.gallery.id, 'kmanga-311334');
      // 2 pages + 1 cover thumbnail = 3 images
      assert.equal(result.images.length, 3);
      // First image is the cover thumbnail (no descramble)
      assert.equal(result.images[0].filename, '00 - Thumbnail.png');
      assert.equal(result.images[0].descramble, undefined);
      // Remaining images have descramble
      assert.equal(result.images[1].descramble.algorithm, 'tile-grid');
      assert.equal(result.images[1].descramble.cols, 4);
      assert.equal(result.images[1].descramble.rows, 4);
      assert.equal(result.images[1].descramble.order.length, 16);
      assert.equal(result.metadata.ComicInfo.Series, 'Attack on Titan');
      assert.equal(result.metadata.ComicInfo.Writer, 'Hajime Isayama');
      assert.equal(result.metadata.ComicInfo.PageCount, 3);
      assert.equal(result.metadata.ComicInfo.Manga, 'YesAndRightToLeft');
    });

    it('returns error when viewer returns no pages', async () => {
      const html = '<html><script id="__NUXT_DATA__">[{"title_name":"Test","episode_id_list":[1]}]</script></html>';
      const result = await KMangaExtractor.extract(
        html,
        'https://kmanga.kodansha.com/title/10072/episode/311334',
        {
          fetchText: async () => JSON.stringify({ data: { viewer_pages: { scramble_seed: '', page_list: [] } } })
        }
      );

      assert.ok(result.error);
      assert.ok(result.error.includes('rental') || result.error.includes('subscription') || result.error.includes('No pages'));
    });
  });

  describe('title/series extraction', () => {
    it('extracts series with chapter stubs from HTML', async () => {
      const html = '<html><script id="__NUXT_DATA__">[{"title_name":"Blue Lock","episode_id_list":[100,200,300],"free_episode_count":3,"author_text":"Muneyuki Kaneshiro","synopsis":"Soccer manga.","title_grid_wide":"https://cdn.kmanga.kodansha.com/bluelock-cover.jpg"}]</script></html>';

      const result = await KMangaExtractor.extract(
        html,
        'https://kmanga.kodansha.com/title/5678',
        {
          fetchText: async (url) => {
            if (url.includes('/web/episode?episode_id=')) {
              const epId = new URL(url).searchParams.get('episode_id');
              return JSON.stringify({
                episode: { episode_id: Number(epId), episode_name: `Ch ${epId}`, point: 0, is_page_visible: 1 }
              });
            }
            return '{}';
          }
        }
      );

      assert.equal(result.provider, 'K MANGA');
      assert.equal(result.isSeries, true);
      assert.equal(result.title, 'Blue Lock');
      assert.deepEqual(result.rootRelativePath, ['Blue Lock']);
      assert.deepEqual(result.cover, { url: 'https://cdn.kmanga.kodansha.com/bluelock-cover.jpg', filename: 'Cover.jpg' });
      assert.deepEqual(result.cleanup, { removeMatchingChapters: true, removeLooseCovers: true });
      assert.equal(result.chapters.length, 3);
      assert.equal(result.chapters[0].id, 'kmanga-100');
      assert.equal(result.chapters[0].sourceUrl, 'https://kmanga.kodansha.com/title/5678/episode/100');
      assert.ok(result.chapters[0].relativePath[0] === 'Blue Lock');
      assert.ok(result.chapters[0].relativePath[1].startsWith('Ch.'));
      assert.equal(result.metadata.ComicInfo.Series, 'Blue Lock');
      assert.equal(result.metadata.ComicInfo.Writer, 'Muneyuki Kaneshiro');
    });

    it('filters out non-free episodes from title extraction', async () => {
      const html = '<html><script id="__NUXT_DATA__">[{"title_name":"Test Series","episode_id_list":[10,20,30,40,50],"free_episode_count":5,"author_text":"Author","title_grid_wide":"https://cdn.kmanga.kodansha.com/cover.jpg"}]</script></html>';

      let queriedIds = [];
      const result = await KMangaExtractor.extract(
        html,
        'https://kmanga.kodansha.com/title/9999',
        {
          fetchText: async (url) => {
            if (url.includes('/web/episode?episode_id=')) {
              const epId = Number(new URL(url).searchParams.get('episode_id'));
              queriedIds.push(epId);
              // First 2 are free, third is login-free (point > 0)
              const point = epId <= 20 ? 0 : 69;
              return JSON.stringify({
                episode: { episode_id: epId, episode_name: `Ep ${epId}`, point, is_page_visible: point === 0 ? 1 : 0 }
              });
            }
            return '{}';
          }
        }
      );

      assert.equal(result.chapters.length, 2);
      assert.equal(result.chapters[0].id, 'kmanga-10');
      assert.equal(result.chapters[1].id, 'kmanga-20');
      // Should stop querying after hitting the first non-free episode
      assert.equal(queriedIds.length, 3);
    });

    it('falls back to free_episode_count when episode detail API is unavailable', async () => {
      const html = '<html><script id="__NUXT_DATA__">[{"title_name":"Imperfect Girl","episode_id_list":[100,200,300,400],"free_episode_count":3,"author_text":"Author","title_grid_wide":"https://cdn.kmanga.kodansha.com/cover.png"},{"episode_id":100,"episode_name":"1","thumbnail_image_url":"https://cdn.kmanga.kodansha.com/thumb1.png","point":0,"is_page_visible":1}]</script></html>';

      const result = await KMangaExtractor.extract(
        html,
        'https://kmanga.kodansha.com/title/10207',
        {
          fetchText: async (url) => {
            if (url.includes('/web/episode?episode_id=')) throw new Error('API unavailable');
            return '{}';
          }
        }
      );

      assert.equal(result.isSeries, true);
      assert.equal(result.chapters.length, 3);
      assert.equal(result.chapters[0].id, 'kmanga-100');
      assert.equal(result.chapters[1].id, 'kmanga-200');
      assert.equal(result.chapters[2].id, 'kmanga-300');
      // First chapter gets name and thumbnail from Nuxt data
      assert.ok(result.chapters[0].title.includes('Ch. 1'));
      assert.ok(result.covers.length > 0);
      // Subsequent chapters use sequential numbering
      assert.ok(result.chapters[1].title.includes('Ch. 2'));
    });

    it('returns error when no title metadata found in HTML', async () => {
      const result = await KMangaExtractor.extract(
        '<html></html>',
        'https://kmanga.kodansha.com/title/5678',
        {}
      );
      assert.ok(result.error);
    });
  });
});

describe('direct image extractor', () => {
  it('matches any-host raster URLs and rejects other shapes', () => {
    assert.equal(DirectExtractor.match('https://example.com/assets/shot.png'), true);
    assert.equal(DirectExtractor.match('https://example.com/assets/photo.JPG?token=abc'), true);
    assert.equal(DirectExtractor.match('https://example.com/a/b/c.webp#frag'), true);
    assert.equal(DirectExtractor.match('https://example.com/a.gif'), true);
    assert.equal(DirectExtractor.match('https://example.com/a.svg'), true);
    assert.equal(DirectExtractor.match('https://example.com/gallery'), false);
    assert.equal(DirectExtractor.match('https://example.com/clip.mp4'), false);
    assert.equal(DirectExtractor.match('https://example.com/icon.ico'), false);
    assert.equal(DirectExtractor.match('blob:https://example.com/abc'), false);
    assert.equal(DirectExtractor.match(''), false);
    assert.equal(DirectExtractor.match(null), false);
  });

  it('flags raster URLs as direct', () => {
    assert.equal(DirectExtractor.isDirectUrl('https://example.com/a.png'), true);
    assert.equal(DirectExtractor.isDirectUrl('https://example.com/a.jpg'), true);
    assert.equal(DirectExtractor.isDirectUrl('https://example.com/a.html'), false);
  });

  it('resolves friendly filenames with host-scoped hashes', async () => {
    const parsed = await DirectExtractor.parseDirectUrl('https://example.com/assets/screenshot.png?token=abc');
    assert.equal(parsed.provider, 'Misc');
    assert.equal(parsed.filename, 'screenshot.png');
    assert.equal(parsed.url, 'https://example.com/assets/screenshot.png?token=abc');
    assert.ok(parsed.hash.startsWith('direct-example-com-screenshot-png'));

    const upper = await DirectExtractor.parseDirectUrl('https://example.com/A.JPG');
    assert.equal(upper.filename, 'A.jpg');

    assert.equal(await DirectExtractor.parseDirectUrl('https://example.com/a.mp4'), null);
    assert.equal(await DirectExtractor.parseDirectUrl('not a url'), null);
  });

  it('loses site CDN URLs to earlier manifest entries', () => {    const manifest = {
      version: 1,
      extractors: [
        {
          id: 'kmanga', name: 'K MANGA', libraryPath: 'KManga', version: 4,
          source: 'kmanga.js',
          patterns: ['^https?://cdn\\.kmanga\\.kodansha\\.com/.+\\.(jpg|jpeg|png|webp)(\\?.*)?$']
        },
        {
          id: 'direct', name: 'Misc', libraryPath: 'Misc', version: 1,
          source: 'direct.js',
          patterns: ['^https?://[^?#]+\\.([jJ][pP][gG]|[jJ][pP][eE][gG]|[pP][nN][gG]|[gG][iI][fF]|[wW][eE][bB][pP]|[aA][vV][iI][fF]|[aA][pP][nN][gG]|[bB][mM][pP]|[sS][vV][gG])([?#].*)?$']
        }
      ]
    };
    assert.equal(
      findExtractor('https://cdn.kmanga.kodansha.com/static/titles/10207/cover.png?x=1', manifest).id,
      'kmanga'
    );
    assert.equal(
      findExtractor('https://example.com/assets/shot.png', manifest).id,
      'direct'
    );
    assert.equal(
      findExtractor('https://example.com/assets/logo.svg', manifest).id,
      'direct'
    );
  });

  it('resolves SVG targets through the sanitized path', async () => {
    const parsed = await DirectExtractor.parseDirectUrl('https://example.com/assets/logo.SVG');
    assert.equal(parsed.provider, 'Misc');
    assert.equal(parsed.filename, 'logo.svg');
  });
});

describe('direct document rejection', () => {
  const toBytes = (payload) => (Array.isArray(payload) ? Uint8Array.from(payload) : Uint8Array.from(Buffer.from(payload)));
  const stubBytes = (payload) => {
    let seenHeaders;
    const fetchBytes = async (url, headers) => {
      seenHeaders = headers;
      return toBytes(payload);
    };
    return { fetchBytes, seenHeaders: () => seenHeaders };
  };

  it('accepts matching magic bytes', async () => {
    const png = stubBytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]);
    const parsed = await DirectExtractor.parseDirectUrl('https://example.com/a.png', png);
    assert.equal(parsed.filename, 'a.png');
    assert.deepEqual(png.seenHeaders(), { Range: 'bytes=0-1023' });

    const jpg = stubBytes([0xFF, 0xD8, 0xFF, 0xE0]);
    assert.equal((await DirectExtractor.parseDirectUrl('https://example.com/a.jpg', jpg)).filename, 'a.jpg');

    const svg = stubBytes([...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')]);
    assert.equal((await DirectExtractor.parseDirectUrl('https://example.com/a.svg', svg)).filename, 'a.svg');
  });

  it('rejects document pages wearing image extensions', async () => {
    const page = stubBytes([...Buffer.from('<!DOCTYPE html><html><head><title>blob</title>')]);
    await assert.rejects(
      DirectExtractor.parseDirectUrl('https://example.com/blob/main/gfl-spinner.svg', page),
      /document page/
    );
    await assert.rejects(
      DirectExtractor.parseDirectUrl('https://example.com/photo.png', page),
      /document page/
    );
  });

  it('rejects mismatched magic bytes', async () => {
    const html = stubBytes([...Buffer.from('<html><body>nope</body>')]);
    await assert.rejects(
      DirectExtractor.parseDirectUrl('https://example.com/a.png', html),
      /document page/
    );
  });

  it('rejects page chrome starting with non-svg tags', async () => {
    const frag = stubBytes([...Buffer.from('\n\n  <a href="#start-of-content"><svg data-component="Octicon"></svg></a>')]);
    await assert.rejects(
      DirectExtractor.parseDirectUrl('https://example.com/file.svg', frag),
      /document page/
    );
  });

  it('accepts prolog-led SVG documents', async () => {
    const koi = stubBytes([...Buffer.from('<?xml version="1.0"?><!-- Generator: Illustrator --><!DOCTYPE svg [<!ENTITY st "x">]><svg><path/></svg>')]);
    assert.equal((await DirectExtractor.parseDirectUrl('https://example.com/koi.svg', koi)).filename, 'koi.svg');
  });

  it('passes through when the window holds prolog only', async () => {
    const prolog = stubBytes([...Buffer.from('<?xml version="1.0"?><!-- Generator: Illustrator --><!DOCTYPE svg [<!ENTITY a "x"><!ENTITY b "y">')]);
    assert.equal((await DirectExtractor.parseDirectUrl('https://example.com/koi.svg', prolog)).filename, 'koi.svg');
  });

  it('passes through on inconclusive answers', async () => {
    const tiny = stubBytes([0x89]);
    assert.equal((await DirectExtractor.parseDirectUrl('https://example.com/a.png', tiny)).filename, 'a.png');
    assert.equal((await DirectExtractor.parseDirectUrl('https://example.com/a.png', {})).filename, 'a.png');
    const failing = { fetchBytes: async () => { throw new Error('nope'); } };
    assert.equal((await DirectExtractor.parseDirectUrl('https://example.com/a.png', failing)).filename, 'a.png');
  });

  it('tolerates base64 byte containers', async () => {
    const b64 = { fetchBytes: async () => Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).toString('base64') };
    assert.equal((await DirectExtractor.parseDirectUrl('https://example.com/a.png', b64)).filename, 'a.png');
  });
});

describe('sanitized SVG downloads', () => {
  let prevWindow;
  let calls;

  beforeEach(() => {
    prevWindow = globalThis.window;
    calls = [];
    globalThis.window = {
      DOMPurify: {
        sanitize: (text, config) => {
          calls.push(config);
          return `clean:${text}`;
        }
      },
      __TAURI__: {
        core: {
          invoke: async (cmd, args) => {
            calls.push({ cmd, args });
            if (cmd === 'fetch_text') return '<svg>raw</svg>';
            return null;
          }
        }
      }
    };
  });

  afterEach(() => {
    globalThis.window = prevWindow;
  });

  it('sanitizes with the SVG profile', () => {
    assert.equal(sanitizeSvgText('<svg>raw</svg>'), 'clean:<svg>raw</svg>');
    assert.deepEqual(calls[0], { USE_PROFILES: { svg: true } });
  });

  it('throws without a sanitizer', () => {
    delete globalThis.window.DOMPurify;
    assert.throws(() => sanitizeSvgText('<svg/>'), /sanitizer unavailable/);
  });

  it('routes .svg downloads through fetch plus text write', async () => {
    await downloadFile('https://example.com/a.svg', 'C:\\Lib\\a.svg');
    const cmds = calls.filter((c) => c.cmd).map((c) => c.cmd);
    assert.deepEqual(cmds, ['fetch_text', 'write_text_file']);
    const write = calls.find((c) => c.cmd === 'write_text_file');
    assert.equal(write.args.path, 'C:\\Lib\\a.svg');
    assert.equal(write.args.content, 'clean:<svg>raw</svg>');
  });

  it('keeps raster downloads on the binary path', async () => {
    await downloadFile('https://example.com/a.png', 'C:\\Lib\\a.png');
    assert.deepEqual(
      calls.filter((c) => c.cmd).map((c) => c.cmd),
      ['download_to_file', 'verify_image_magic']
    );
    const verify = calls.find((c) => c.cmd === 'verify_image_magic');
    assert.equal(verify.args.path, 'C:\\Lib\\a.png');
    assert.equal(verify.args.expectedExt, 'png');
  });

  it('deletes corrupt downloads and reports', async () => {
    const cmds = [];
    globalThis.window.__TAURI__.core.invoke = async (cmd, args) => {
      cmds.push(cmd);
      if (cmd === 'verify_image_magic') throw new Error('Downloaded file is not a valid png image');
      return null;
    };
    await assert.rejects(
      downloadFile('https://example.com/a.png', 'C:\\Lib\\a.png'),
      /not a valid png image/
    );
    assert.ok(cmds.includes('remove_file'));
  });

  it('refuses emptied documents', async () => {
    globalThis.window.DOMPurify.sanitize = () => '   ';
    await assert.rejects(
      downloadSanitizedSvg('https://example.com/a.svg', 'C:\\Lib\\a.svg'),
      /emptied/
    );
  });

  it('refuses document text at the sanitized gate', async () => {
    globalThis.window.__TAURI__.core.invoke = async (cmd) => {
      if (cmd === 'fetch_text') return '\n\n  <a href="#x"><svg data-component="Octicon"></svg></a>';
      return null;
    };
    await assert.rejects(
      downloadSanitizedSvg('https://example.com/blob/f.svg', 'C:\\Lib\\f.svg'),
      /document page/
    );
  });

  it('passes prolog-led SVG text through the gate', async () => {
    globalThis.window.__TAURI__.core.invoke = async (cmd) => {
      if (cmd === 'fetch_text') return '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY s "x">]><svg><path/></svg>';
      if (cmd === 'write_text_file') {
        calls.push({ cmd });
        return null;
      }
      return null;
    };
    await downloadSanitizedSvg('https://example.com/koi.svg', 'C:\\Lib\\koi.svg');
    assert.ok(calls.some((c) => c.cmd === 'write_text_file'));
  });
});

describe('SVG entity pre-expansion', () => {
  it('expands Illustrator-style entities and drops the doctype', () => {
    const input = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY st12 "fill:url(#SVGID_1_);"><!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">]><svg><path style="&st12;"/></svg>';
    assert.equal(
      expandSvgEntities(input),
      '<svg><path style="fill:url(#SVGID_1_);"/></svg>'
    );
  });

  it('leaves entity-free documents untouched', () => {
    assert.equal(expandSvgEntities('<svg><circle/></svg>'), '<svg><circle/></svg>');
  });

  it('expands nested literals exactly once without amplifying', () => {
    assert.equal(
      expandSvgEntities('<!DOCTYPE svg [<!ENTITY lol "a&b;">]><svg>&lol;</svg>'),
      '<svg>a&b;</svg>'
    );
    let attack = '<!DOCTYPE svg [';
    for (let i = 0; i < 9; i++) attack += `<!ENTITY lol${i} "&lol;">`;
    attack += ']><svg>&lol8;</svg>';
    const out = expandSvgEntities(attack);
    assert.ok(!out.includes('<!ENTITY'));
    assert.ok(out.length < 1000);
  });

  it('rejects external entities', () => {
    const input = '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg>&xxe;</svg>';
    assert.throws(() => expandSvgEntities(input), /entity block rejected/);
  });

  it('rejects parameter entities', () => {
    const input = '<!DOCTYPE svg [<!ENTITY % pe "x">]><svg></svg>';
    assert.throws(() => expandSvgEntities(input), /entity block rejected/);
  });
});

describe('url layer contract', () => {
  const contractEntry = {
    id: 'harbor', name: 'Harbor', libraryPath: 'Harbor',
    version: 1, source: 'harbor.js', patterns: ['^https?://harbor\\.test/']
  };

  function mockTauri(dirs, files) {
    if (!globalThis.window) globalThis.window = {};
    globalThis.window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          if (cmd === 'read_directory') return dirs[args.path] || { files: [] };
          if (cmd === 'read_text_file') {
            if (files[args.path]) return files[args.path];
            throw new Error('File not found');
          }
          if (cmd === 'remove_file' || cmd === 'remove_directory') {
            mockTauri.deleted.push(args.path);
            return;
          }
          if (cmd === 'write_text_file') {
            mockTauri.written = JSON.parse(args.content);
            return;
          }
          throw new Error(`Unknown cmd ${cmd}`);
        }
      }
    };
    mockTauri.deleted = [];
    mockTauri.written = null;
  }

  describe('validation', () => {
    it('accepts an absorbed-list image and rejects malformed lists', () => {
      const valid = validateExtractorResult({
        provider: 'Harbor',
        gallery: { id: 'harbor-7', relativePath: ['Harbor Bay'] },
        images: [{
          url: 'https://cdn.harbor.test/00.png',
          filename: '00.png',
          supersedes: ['https://cdn.harbor.test/tide.png']
        }]
      }, contractEntry);
      assert.deepEqual(valid.images[0].supersedes, ['https://cdn.harbor.test/tide.png']);

      assert.throws(() => validateExtractorResult({
        provider: 'Harbor',
        gallery: { id: 'harbor-7', relativePath: ['Harbor Bay'] },
        images: [{ url: 'https://cdn.harbor.test/00.png', filename: '00.png', supersedes: [null] }]
      }, contractEntry), /supersedes entry/);
    });

    it('accepts a stub cover and rejects a cover without address', () => {
      const series = validateExtractorResult({
        provider: 'Harbor',
        isSeries: true,
        rootRelativePath: ['Harbor Bay'],
        chapters: [{
          id: 'harbor-c1',
          sourceUrl: 'https://harbor.test/ch/1',
          relativePath: ['Harbor Bay', 'Ch. 1'],
          cover: { url: 'https://cdn.harbor.test/c1.png', filename: 'Ch. 1 Cover.png' }
        }]
      }, contractEntry);
      assert.equal(series.chapters[0].cover.filename, 'Ch. 1 Cover.png');

      assert.throws(() => validateExtractorResult({
        provider: 'Harbor',
        isSeries: true,
        rootRelativePath: ['Harbor Bay'],
        chapters: [{
          id: 'harbor-c1',
          sourceUrl: 'https://harbor.test/ch/1',
          relativePath: ['Harbor Bay', 'Ch. 1'],
          cover: { url: '', filename: 'Ch. 1 Cover.png' }
        }]
      }, contractEntry), /invalid image URL/);
    });
  });

  describe('match sets', () => {
    it('builds one vocabulary from image-likes plus absorbed lists', () => {
      const sets = buildMatchSets([{
        filename: '00.png',
        url: 'https://cdn.harbor.test/00.png?token=N',
        hash: 'harbor-00',
        supersedes: ['https://cdn.harbor.test/tide.png?token=O']
      }]);
      assert.ok(sets.urls.has('https://cdn.harbor.test/00.png?token=n'));
      assert.ok(sets.urls.has('https://cdn.harbor.test/tide.png?token=o'));
      assert.ok(sets.stems.has('00'));
      assert.ok(sets.stems.has('tide'));
      assert.ok(sets.stems.has('harbor-00'));
      assert.ok(sets.filenames.has('00.png'));
    });

    it('folds cover extras and policy extras into shared sets', () => {
      const sets = buildMatchSets([]);
      addCoverIdentifiers(sets, [{
        filename: 'Cover.jpg',
        url: 'https://cdn.harbor.test/cover.jpg',
        filenames: ['Harbor Bay - Vol. 02 Cover.jpg']
      }], 'Harbor Bay', { matchStems: ['harbor-extra'] });
      assert.ok(sets.filenames.has('harbor bay - vol. 02 cover.jpg'));
      assert.ok(sets.stems.has('harbor bay - vol. 02 cover'));
      assert.ok(sets.stems.has('harbor-extra'));
      assert.ok(!sets.filenames.has('cover.jpg'));
    });
  });

  describe('record matching', () => {
    it('ranks exact above fuzzy and covers below content', () => {
      const keys = { urls: new Set(['https://cdn.polar.test/01.png']), stems: new Set(['frost']) };
      assert.equal(matchSidecarRecord({
        filename: 'a.png', sourceUrl: 'https://cdn.polar.test/01.png', url: ''
      }, keys), 'exact');
      assert.equal(matchSidecarRecord({
        filename: 'b.png', sourceUrl: 'https://cdn.polar.test/other.png', hash: 'frost'
      }, keys), 'fuzzy');
      assert.equal(matchSidecarRecord({
        filename: 'c.png', sourceUrl: 'https://cdn.polar.test/unrelated.png'
      }, keys), 'none');
      assert.equal(matchSidecarRecord(null, keys), 'none');
    });
  });

  describe('unified root cleanup', () => {
    it('absorbs a renamed standalone and prunes its record', async () => {
      const tide = 'https://cdn.harbor.test/tide.png';
      mockTauri(
        { 'C:\\library\\Harbor': { files: [{ name: 'harbor-tide.png', path: 'C:\\library\\Harbor\\harbor-tide.png', is_dir: false }] } },
        { 'C:\\library\\Harbor\\gallery.json': JSON.stringify({ provider: 'Harbor', isRoot: true, images: [{ filename: 'harbor-tide.png', sourceUrl: tide, url: tide }] }) }
      );
      await cleanupMatchingRawFiles('C:\\library\\Harbor', [{ filename: '00.png', url: tide, sourceUrl: tide }]);
      assert.deepEqual(mockTauri.deleted, ['C:\\library\\Harbor\\harbor-tide.png', 'C:\\library\\Harbor\\gallery.json']);
    });

    it('absorbs a host-variant cover through a shared stem', async () => {
      const stem = 'aaabbbcc-ddeeff';
      mockTauri(
        { 'C:\\library\\Harbor': { files: [{ name: 'Harbor - Nb Cover.jpg', path: 'C:\\library\\Harbor\\Harbor - Nb Cover.jpg', is_dir: false }] } },
        { 'C:\\library\\Harbor\\gallery.json': JSON.stringify({ provider: 'Harbor', isRoot: true, images: [{ filename: 'Harbor - Nb Cover.jpg', rawFileName: `${stem}.jpg`, hash: stem, sourceUrl: `https://cdn.harbor.test/nb/${stem}.jpg`, url: `https://cdn.harbor.test/nb/${stem}.jpg` }] }) }
      );
      await cleanupMatchingRawFiles('C:\\library\\Harbor', [{
        filename: 'Nb.jpg', url: `https://static.harbor.test/nb/${stem}.jpg`, rawFileName: `${stem}.jpg`, hash: stem
      }]);
      assert.deepEqual(mockTauri.deleted, ['C:\\library\\Harbor\\Harbor - Nb Cover.jpg', 'C:\\library\\Harbor\\gallery.json']);
    });
  });

  describe('contract jump ranking', () => {
    it('jumps into the gallery copy over a root standalone', async () => {
      const tide = 'https://cdn.polar.test/tide.png';
      mockTauri(
        {
          'C:\\library\\Polar': { files: [{ name: 'Bay - Ch. 01', path: 'C:\\library\\Polar\\Bay - Ch. 01', is_dir: true }] },
          'C:\\library\\Polar\\Bay - Ch. 01': { files: [] }
        },
        {
          'C:\\library\\Polar\\gallery.json': JSON.stringify({ provider: 'Polar', isRoot: true, images: [{ filename: 'polar-tide.png', sourceUrl: tide, url: tide }] }),
          'C:\\library\\Polar\\Bay - Ch. 01\\gallery.json': JSON.stringify({ url: 'https://polar.test/t/1/e/1', provider: 'Polar', gallery: { id: 'polar-1', relativePath: ['Bay - Ch. 01'] }, images: [{ filename: '00.png', sourceUrl: tide, url: tide }] })
        }
      );
      const match = await findMatchingGalleryImage('C:\\library\\Polar', tide, 'tide');
      assert.ok(match);
      assert.equal(match.galleryPath, 'C:\\library\\Polar\\Bay - Ch. 01');
      assert.equal(match.targetName, '00.png');
    });

    it('an exact address beats a fuzzy stem inside one tier', async () => {
      const exactUrl = 'https://cdn.polar.test/loose.png';
      mockTauri(
        {
          'C:\\library\\Polar': { files: [{ name: 'Deep Gallery', path: 'C:\\library\\Polar\\Deep Gallery', is_dir: true }] },
          'C:\\library\\Polar\\Deep Gallery': { files: [] }
        },
        {
          'C:\\library\\Polar\\Deep Gallery\\gallery.json': JSON.stringify({ url: 'https://polar.test/g/9', provider: 'Polar', gallery: { id: 'polar-9', relativePath: ['Deep Gallery'] }, images: [{ filename: 'fuzzy.png', sourceUrl: 'https://cdn.polar.test/other.png?tag=loose' }, { filename: 'exact.png', sourceUrl: exactUrl, url: exactUrl }] })
        }
      );
      const match = await findMatchingGalleryImage('C:\\library\\Polar', exactUrl, 'loose');
      assert.ok(match);
      assert.equal(match.galleryPath, 'C:\\library\\Polar\\Deep Gallery');
      assert.equal(match.targetName, 'exact.png');
    });

    it('a lone series cover still resolves', async () => {
      const coverUrl = 'https://cdn.polar.test/cover.jpg';
      mockTauri(
        { 'C:\\library\\Polar': { files: [{ name: 'Bay', path: 'C:\\library\\Polar\\Bay', is_dir: true }] }, 'C:\\library\\Polar\\Bay': { files: [] } },
        { 'C:\\library\\Polar\\Bay\\gallery.json': JSON.stringify({ url: 'https://polar.test/t/2', provider: 'Polar', gallery: { id: 'polar-2', relativePath: ['Bay'] }, images: [{ filename: 'Cover.jpg', description: 'Series Cover', sourceUrl: coverUrl }] }) }
      );
      const match = await findMatchingGalleryImage('C:\\library\\Polar', coverUrl, 'cover');
      assert.ok(match);
      assert.equal(match.targetName, 'Cover.jpg');
    });
  });

  describe('stub cover records', () => {
    it('maps a valid cover last and rejects bad shapes', () => {
      assert.deepEqual(buildStubCoverRecord({ url: 'https://cdn.polar.test/c1.png', filename: 'Ch. 1 Cover.png' }), {
        filename: 'Ch. 1 Cover.png',
        displayName: 'Ch. 1 Cover.png',
        description: 'Series Cover',
        sourceUrl: 'https://cdn.polar.test/c1.png'
      });
      assert.equal(buildStubCoverRecord(null), null);
      assert.equal(buildStubCoverRecord({ url: '', filename: 'Cover.png' }), null);
    });
  });

  describe('extractor adoption', () => {
    it('episode covers carry their absorbed address', async () => {
      const thumb = 'https://cdn.north.test/tide.png';
      const html = `<html><script id="__NUXT_DATA__">[{"title_name":"North Star","episode_id_list":[555],"author_text":"Anon"},{"episode_id":555,"episode_name":"07","thumbnail_image_url":"${thumb}"}]</script></html>`;
      const viewer = JSON.stringify({ data: { viewer_pages: { scramble_seed: 'seed1', page_list: ['https://cdn.north.test/p1.jpg'] } } });
      const result = await KMangaExtractor.extract(html, 'https://kmanga.kodansha.com/title/321/episode/555', {
        fetchText: async () => viewer
      });
      assert.equal(result.images[0].filename, '00 - Thumbnail.png');
      assert.deepEqual(result.images[0].supersedes, [thumb]);
    });

    it('sized cover variants normalize to their canonical file', async () => {
      const mangaId = '11111111-2222-4333-8444-555555555555';
      const canonical = 'abcdef01-2345-6789-abcd-ef0123456789.jpg';
      const sized = await MangaDexExtractor.parseDirectUrl(`https://mangadex.org/covers/${mangaId}/${canonical}.512.jpg`, {});
      assert.equal(sized.rawFileName, canonical);
      const sets = buildMatchSets([{
        filename: 'Vol. 01.jpg',
        url: `https://uploads.mangadex.org/covers/${mangaId}/${canonical}`,
        rawFileName: canonical,
        hash: canonical.replace(/\.[^.]+$/, '')
      }]);
      const verdict = matchSidecarRecord({
        filename: sized.filename, rawFileName: sized.rawFileName, hash: sized.hash, sourceUrl: sized.url, url: sized.url
      }, sets);
      assert.ok(verdict === 'exact' || verdict === 'fuzzy');
    });
  });
});



