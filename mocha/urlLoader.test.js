import assert from 'node:assert/strict';
import {
  normalizeUrl,
  isValidUrl,
  findMatchingGalleryImage,
  cleanupMatchingRawFiles
} from '../src/js/urlLoader.js';
import * as ImgurExtractor from '../extractors/imgur.js';

describe('UrlLoader and Imgur extractor direct URL handling', () => {
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
