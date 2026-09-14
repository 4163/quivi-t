import assert from 'node:assert/strict';

// Mock minimal browser globals for Node test environment
if (typeof window === 'undefined') {
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async () => ({}),
        convertFileSrc: (p) => p
      }
    },
    dispatchEvent: () => {}
  };
}

const {
  findMetadataEntry,
  parseComicInfoJson,
  parseGalleryMetaJson
} = await import('../src/js/metadata.js');
const { isMetadataEntryName } = await import('../src/js/services/metadataFiles.js');

describe('Metadata extraction and parsing', () => {
  describe('findMetadataEntry priority and matching', () => {
    it('returns null when no metadata file is present', () => {
      const files = ['001.jpg', '002.png', 'notes.txt'];
      assert.equal(findMetadataEntry(files), null);
    });

    it('matches comicinfo.json and meta.json case-insensitively', () => {
      assert.equal(findMetadataEntry(['001.jpg', 'ComicInfo.JSON']), 'ComicInfo.JSON');
      assert.equal(findMetadataEntry(['001.jpg', 'META.json']), 'META.json');
      assert.equal(findMetadataEntry(['001.jpg', 'nested/path/comicinfo.json']), 'nested/path/comicinfo.json');
    });

    it('adheres to metadata format priority order', () => {
      // ComicInfo.xml beats ComicInfo.json
      assert.equal(
        findMetadataEntry(['meta.json', 'comicinfo.json', 'ComicInfo.xml']),
        'ComicInfo.xml'
      );

      // ComicInfo.json beats meta.json
      assert.equal(
        findMetadataEntry(['metadata.opf', 'meta.json', 'comicinfo.json']),
        'comicinfo.json'
      );

      // meta.json beats comet.xml and metadata.opf
      assert.equal(
        findMetadataEntry(['metadata.opf', 'comet.xml', 'meta.json']),
        'meta.json'
      );
    });

    it('identifies valid metadata basenames', () => {
      assert.equal(isMetadataEntryName('comicinfo.json'), true);
      assert.equal(isMetadataEntryName('nested/path/comet.json'), true);
      assert.equal(isMetadataEntryName('notmeta.json'), false);
      assert.equal(isMetadataEntryName('mycomicinfo.json'), false);
    });
  });

  describe('parseComicInfoJson', () => {
    it('parses standard PascalCase ComicInfo properties', () => {
      const payload = {
        Title: 'Hero Adventure',
        Series: 'Legends Chronicle',
        Number: '12',
        Count: '24',
        Volume: '2',
        Summary: 'The hero embarks on a quest.',
        Notes: 'Scanned from retail volume.',
        Year: 2024,
        Month: 6,
        Writer: 'Jane Author',
        Penciller: 'John Artist',
        Publisher: 'Epic Comics',
        Genre: 'Fantasy, Action',
        Tags: 'Adventure, Swords, Magic',
        PageCount: 32,
        Manga: 'YesAndRightToLeft',
        LanguageISO: 'en',
        CommunityRating: '4.8'
      };

      const meta = parseComicInfoJson(payload);
      assert.equal(meta.title, 'Hero Adventure');
      assert.equal(meta.series, 'Legends Chronicle');
      assert.equal(meta.number, '12');
      assert.equal(meta.count, '24');
      assert.equal(meta.volume, '2');
      assert.equal(meta.summary, 'The hero embarks on a quest.');
      assert.equal(meta.notes, 'Scanned from retail volume.');
      assert.equal(meta.year, 2024);
      assert.equal(meta.month, 6);
      assert.equal(meta.writer, 'Jane Author');
      assert.equal(meta.penciller, 'John Artist');
      assert.equal(meta.publisher, 'Epic Comics');
      assert.equal(meta.genre, 'Fantasy, Action');
      assert.equal(meta.tags, 'Adventure, Swords, Magic');
      assert.equal(meta.pageCount, 32);
      assert.equal(meta.manga, 'YesAndRightToLeft');
      assert.equal(meta.languageISO, 'en');
      assert.equal(meta.rating, '4.8');
    });

    it('supports nested ComicInfo root object and camelCase keys', () => {
      const payload = {
        ComicInfo: {
          title: 'Side Quest',
          series: 'Legends Chronicle',
          issue: '3.5',
          totalIssues: '5',
          writers: ['Jane Author', 'Co-Writer'],
          tags: ['Fantasy', 'Side Story'],
          manga: true,
          pages: '28',
          year: '2023',
          month: '11',
          rating: '4.5'
        }
      };

      const meta = parseComicInfoJson(payload);
      assert.equal(meta.title, 'Side Quest');
      assert.equal(meta.series, 'Legends Chronicle');
      assert.equal(meta.number, '3.5');
      assert.equal(meta.count, '5');
      assert.equal(meta.writer, 'Jane Author, Co-Writer');
      assert.equal(meta.tags, 'Fantasy, Side Story');
      assert.equal(meta.manga, 'Yes');
      assert.equal(meta.pageCount, 28);
      assert.equal(meta.year, 2023);
      assert.equal(meta.month, 11);
      assert.equal(meta.rating, '4.5');
    });

    it('handles invalid or empty payload safely', () => {
      assert.equal(parseComicInfoJson(null), null);
      assert.equal(parseComicInfoJson(undefined), null);
      assert.equal(parseComicInfoJson('invalid string'), null);

      const empty = parseComicInfoJson({});
      assert.equal(empty.title, '');
      assert.equal(empty.series, '');
      assert.equal(empty.year, null);
      assert.equal(empty.pageCount, null);
    });
  });

  describe('parseGalleryMetaJson', () => {
    it('extracts multilingual titles, tags, and timestamps', () => {
      const payload = {
        id: 998877,
        title: {
          english: 'Galactic Horizon - Chapter 1',
          japanese: '銀河ホライズン 第1話'
        },
        upload_date: 1700000000,
        num_pages: 42,
        scanlator: 'Cosmic Translations',
        tags: [
          { id: 1, type: 'parody', name: 'Original Sci-Fi' },
          { id: 2, type: 'artist', name: 'Astro Artist' },
          { id: 3, type: 'group', name: 'Nebula Circle' },
          { id: 4, type: 'category', name: 'Manga' },
          { id: 5, type: 'character', name: 'Captain Nova' },
          { id: 6, type: 'tag', name: 'Full Color' },
          { id: 7, type: 'tag', name: 'Space Exploration' },
          { id: 8, type: 'language', name: 'english' }
        ]
      };

      const meta = parseGalleryMetaJson(payload);
      assert.equal(meta.title, 'Galactic Horizon - Chapter 1');
      assert.equal(meta.series, 'Original Sci-Fi');
      assert.equal(meta.writer, 'Astro Artist');
      assert.equal(meta.penciller, 'Astro Artist');
      assert.equal(meta.publisher, 'Nebula Circle');
      assert.equal(meta.genre, 'Manga');
      assert.equal(meta.tags, 'Full Color, Space Exploration, Captain Nova');
      assert.equal(meta.languageISO, 'english');
      assert.equal(meta.pageCount, 42);
      assert.equal(meta.year, 2023);
      assert.equal(meta.month, 11);
      assert.equal(meta.manga, 'Yes');
      assert.equal(meta.notes, 'Scanlator: Cosmic Translations');
    });

    it('handles minimal payload and invalid inputs safely', () => {
      const minimal = parseGalleryMetaJson({
        title: 'Single Issue Story',
        num_pages: 16
      });
      assert.equal(minimal.title, 'Single Issue Story');
      assert.equal(minimal.pageCount, 16);
      assert.equal(minimal.year, null);

      assert.equal(parseGalleryMetaJson(null), null);
      assert.equal(parseGalleryMetaJson(undefined), null);
      assert.equal(parseGalleryMetaJson('not-json'), null);
    });
  });
});
