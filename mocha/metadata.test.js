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

if (typeof DOMParser === 'undefined') {
  globalThis.DOMParser = class DOMParser {
    parseFromString(text) {
      return {
        getElementsByTagNameNS: (_ns, tag) => {
          const match = text.match(new RegExp(`<(?:dc:)?${tag}[^>]*>([^<]+)<\\/(?:dc:)?${tag}>`, 'i'));
          return match ? [{ textContent: match[1] }] : [];
        },
        querySelector: (sel) => {
          if (sel === 'parsererror') {
            if (text.startsWith('<unclosed')) return {};
            return null;
          }
          if (sel.startsWith('meta[')) {
            const m = sel.match(/name="([^"]+)"/);
            if (m) {
              const metaRegex = new RegExp(`<meta[^>]*name=["']${m[1]}["'][^>]*content=["']([^"']+)["']`, 'i');
              const match = text.match(metaRegex);
              if (match) {
                return {
                  textContent: match[1],
                  getAttribute: (attr) => (attr === 'content' ? match[1] : '')
                };
              }
            }
            return null;
          }
          const tags = sel.split(',').map(s => s.trim().replace(/^dc\\:/i, ''));
          for (const t of tags) {
            const match = text.match(new RegExp(`<(?:dc:)?${t}[^>]*>([^<]+)<\\/(?:dc:)?${t}>`, 'i'));
            if (match) {
              return {
                textContent: match[1],
                getAttribute: () => ''
              };
            }
          }
          return null;
        }
      };
    }
  };
}

const {
  findMetadataEntry,
  parseComicInfoJson,
  parseGalleryMetaJson,
  parseMetadataText,
  fetchDirectoryMetadata
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

    it('incorporates Demographic into Tags without duplicating existing tag', () => {
      const withDemo = parseComicInfoJson({
        Title: 'Test Manga',
        Demographic: 'Seinen',
        Tags: 'Action, Slice of Life'
      });
      assert.equal(withDemo.tags, 'Seinen, Action, Slice of Life');

      const alreadyHasDemo = parseComicInfoJson({
        Title: 'Test Manga',
        Demographic: 'Shounen',
        Tags: 'Shounen, Comedy, School'
      });
      assert.equal(alreadyHasDemo.tags, 'Shounen, Comedy, School');

      const onlyDemo = parseComicInfoJson({
        Title: 'Test Manga',
        Demographic: 'Josei'
      });
      assert.equal(onlyDemo.tags, 'Josei');
    });
  });

  describe('parseMetadataText', () => {
    it('parses comicinfo.json and meta.json text formats', () => {
      const comicJson = JSON.stringify({
        ComicInfo: {
          Title: 'Story Arc',
          Writer: 'Author Name',
          Genre: 'Sci-Fi'
        }
      });
      const meta = parseMetadataText(comicJson, 'comicinfo.json');
      assert.equal(meta.title, 'Story Arc');
      assert.equal(meta.writer, 'Author Name');
      assert.equal(meta.genre, 'Sci-Fi');

      const metaJson = JSON.stringify({
        title: 'Gallery Title',
        tags: [{ type: 'artist', name: 'Illustrator' }]
      });
      const galleryMeta = parseMetadataText(metaJson, 'meta.json');
      assert.equal(galleryMeta.title, 'Gallery Title');
      assert.equal(galleryMeta.writer, 'Illustrator');
    });

    it('parses ComicInfo.xml and metadata.opf text formats', () => {
      const xml = '<?xml version="1.0"?><ComicInfo><Title>XML Title</Title><Writer>XML Author</Writer></ComicInfo>';
      const meta = parseMetadataText(xml, 'ComicInfo.xml');
      assert.equal(meta.title, 'XML Title');
      assert.equal(meta.writer, 'XML Author');

      const opf = '<package><metadata><dc:title>OPF Title</dc:title><dc:creator>OPF Creator</dc:creator></metadata></package>';
      const opfMeta = parseMetadataText(opf, 'metadata.opf');
      assert.equal(opfMeta.title, 'OPF Title');
      assert.equal(opfMeta.writer, 'OPF Creator');
    });

    it('returns null on invalid or empty text inputs', () => {
      assert.equal(parseMetadataText('', 'comicinfo.json'), null);
      assert.equal(parseMetadataText(null, 'comicinfo.json'), null);
      assert.equal(parseMetadataText('invalid json', 'comicinfo.json'), null);
      assert.equal(parseMetadataText('<unclosed', 'comicinfo.xml'), null);
      assert.equal(parseMetadataText('hello', 'unknown.ext'), null);
    });
  });

  describe('fetchDirectoryMetadata', () => {
    it('returns null when directory is null, empty or invoke returns null', async () => {
      assert.equal(await fetchDirectoryMetadata(null), null);
      assert.equal(await fetchDirectoryMetadata(''), null);
      assert.equal(await fetchDirectoryMetadata('C:\\some\\dir'), null);
    });

    it('fetches and parses directory metadata via Tauri invoke', async () => {
      const origInvoke = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (cmd, args) => {
        if (cmd === 'find_directory_metadata') {
          return {
            meta_path: 'C:\\Library\\MangaDex\\Series\\comicinfo.json',
            dir_path: 'C:\\Library\\MangaDex\\Series',
            content: JSON.stringify({
              ComicInfo: {
                Title: 'Series Title',
                Writer: 'Author'
              }
            })
          };
        }
        return origInvoke(cmd, args);
      };

      try {
        const result = await fetchDirectoryMetadata('C:\\Library\\MangaDex\\Series');
        assert.notEqual(result, null);
        assert.equal(result.meta.title, 'Series Title');
        assert.equal(result.meta.writer, 'Author');
        assert.equal(result.metaPath, 'C:\\Library\\MangaDex\\Series\\comicinfo.json');
        assert.equal(result.dirPath, 'C:\\Library\\MangaDex\\Series');
      } finally {
        window.__TAURI__.core.invoke = origInvoke;
      }
    });
  });
});

