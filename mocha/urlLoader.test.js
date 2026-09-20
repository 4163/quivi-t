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
  extractUrlStem,
  isDirectMediaUrl,
  findExtractor
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

    it('rejects series title URLs with a helpful prompt to use chapter links', async () => {
      await assert.rejects(
        () => MangaDexExtractor.extract('', 'https://mangadex.org/title/127820bd-8fc5-47b8-8782-e680317bf41d'),
        /MangaDex series links contain multiple chapters/
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
        url: 'https://mangadex.org/covers/4265c437-7d57-4d31-9b1d-0e574a07b7b7/03a1927d-9c79-4bc8-9d06-502cbeb408ff.jpg'
      });
    });
  });
});


