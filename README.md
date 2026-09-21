# QuiviT website extractors

This orphan branch hosts the runtime registry and site extractors for QuiviT web imports.

QuiviT fetches `manifest.json` and matching extractor scripts directly from this branch at runtime. Maintainers can add or update individual website extractors here without rebuilding or releasing the main desktop application.

## How it works

1. A user triggers Open URL (`Ctrl+I`) in QuiviT and pastes a link.
2. QuiviT checks `manifest.json` on this branch to find a matching pattern.
3. The app downloads the matching extractor script, caches it under `%LOCALAPPDATA%/QuiviT/extractor-cache/`, and loads it as a dynamic ES module.
4. The extractor returns image URLs and gallery metadata. QuiviT then downloads the images to the user's Library.

## Repository layout

- `manifest.json`: Registry listing available extractors, URL patterns, versions, and source paths.
- `<site>.js`: Extractor entries exporting `match` and `extract` (for example, `imgur.js`, `mangadex.js`, `mangaplus.js`).
- `shared/`: Library modules shared between extractors. Never manifest entries, never loaded directly by the app.
- `README.md`: Authoring contract and contribution guidelines.

## Manifest schema

`manifest.json` uses version 1:

```json
{
  "version": 1,
  "extractors": [
    {
      "id": "imgur",
      "name": "Imgur",
      "libraryPath": "Imgur",
      "version": 1,
      "source": "imgur.js",
      "patterns": [
        "^https?:\\/\\/(?:[a-zA-Z0-9-]+\\.)?imgur\\.com\\/(?:a|gallery)\\/[a-zA-Z0-9]+",
        "^https?:\\/\\/(?:i\\.)?imgur\\.com\\/[a-zA-Z0-9]+(\\.[a-zA-Z0-9]+)?$"
      ]
    }
  ]
}
```

### Manifest fields

- `id`: Unique identifier using lower-case letters, numbers, and hyphens.
- `name`: Human-readable name used in status labels.
- `libraryPath`: Directory name where downloaded galleries land under the user Library.
- `version`: Positive integer. Bump this number whenever you update an extractor script so running clients invalidate their module cache.
- `source`: Relative filename for the extractor script. Must end in `.js`. Path traversal is rejected.
- `patterns`: Array of regular expression strings tested against user URLs.

## Shared dependencies

An extractor that needs shared code declares it in a header comment on the first line:

```js
// quivit-deps: shared/sanitize.js, shared/mangaplus.js
import { sanitizePathSegment } from './shared/sanitize.js';
```

The loader fetches the listed files from this branch, follows their own sub-dependencies, and rewrites the imports at load time. Authors write plain relative imports. Rules:

- Every relative import must be declared in the header. Undeclared imports fail loading with a clear error.
- Dependency paths must stay inside the branch (no `..`) and end in `.js`.
- Shared files are libraries only. They must not export `match` or `extract`, and they are never added to the manifest.
- Pushing a shared fix reaches users on the next load. Bump the version of every entry that depends on it, per the workflow below.

## Host capabilities

Some extractors need host powers beyond `fetchText`. They declare them on the second header line:

```js
// quivit-needs: fetchBytes, requestHeaders, xorDecrypt
```

If the running QuiviT does not support a named capability, loading fails fast with an update message instead of a cryptic runtime error. Capabilities are generic client features, defined once in the app:

- `fetchBytes`: Binary fetch returning bytes, for protobuf and other non-text payloads.
- `requestHeaders`: Custom request headers on fetch and download (session tokens, view tokens).
- `xorDecrypt`: Per-image descriptors carrying `{ algorithm: 'xor', key }`, decrypted before the file is saved.

## Extractor module contract

An extractor must be an ES module exporting two functions: `match(url)` and `extract(html, url, context)`.

```js
export function match(url) {
  return /^https?:\/\/(?:[a-zA-Z0-9-]+\.)?example\.com\/gallery\/\d+/i.test(url);
}

export async function extract(html, url, context) {
  // Use context.fetchText(pageUrl) for extra pages or API calls.
  return {
    provider: 'Example',
    title: 'Gallery Title',
    gallery: {
      id: 'gallery-123',
      relativePath: ['Category', 'Gallery Title']
    },
    images: [
      {
        url: 'https://cdn.example.com/images/001.jpg',
        filename: '001.jpg',
        description: 'Page 1'
      }
    ],
    nextPageUrl: null
  };
}
```

### Return shapes

An extractor returns either a single gallery result or a series result.

#### Single gallery

```js
return {
  provider: 'Example',
  title: 'Gallery Title',
  gallery: {
    id: 'gallery-123',
    relativePath: ['Category', 'Gallery Title']
  },
  images: [
    {
      url: 'https://cdn.example.com/images/001.jpg',
      filename: '001.jpg',
      description: 'Page 1'
    }
  ],
  metadata: {
    ComicInfo: {
      Series: 'Series Name',
      Title: 'Gallery Title',
      Summary: 'Synopsis...'
    }
  },
  nextPageUrl: null
};
```

- `provider`: String matching the `name` defined in `manifest.json`.
- `title`: String gallery name.
- `gallery.id`: Stable unique identifier for the gallery on that site.
- `gallery.relativePath`: Array of safe directory names under `libraryPath`. Maximum depth is 8.
- `images`: Array of media entries with direct HTTP or HTTPS download URLs and safe filenames.
- `metadata`: Optional metadata payload for the gallery folder. An object serializes to `comicinfo.json`. A string starting with `<` serializes to `comicinfo.xml`. An object with `{ filename, content }` writes a custom file.
- `targetFilename`: Optional string filename of a target image within `images`. When specified, QuiviT eagerly downloads this image first, opens the viewer centered on it, and prefetches remaining images around it.
- `nextPageUrl`: Next page URL for multi-page galleries, or `null` when complete. Consecutive pages must preserve identical `gallery.id` and `gallery.relativePath`.

#### Series

Extractors that index multi-chapter manga or multi-part releases set `isSeries: true`:

```js
return {
  provider: 'Example',
  isSeries: true,
  title: 'Series Title',
  rootRelativePath: ['Series Title'],
  metadata: {
    ComicInfo: {
      Series: 'Series Title',
      Summary: 'Series synopsis...',
      Writer: 'Author'
    }
  },
  cover: {
    url: 'https://cdn.example.com/cover.jpg',
    filename: 'Cover.jpg'
  },
  folders: [
    {
      relativePath: ['Series Title', 'English'],
      metadata: {
        ComicInfo: {
          Series: 'Series Title',
          Title: 'Series Title (English)',
          LanguageISO: 'en'
        }
      }
    }
  ],
  chapters: [
    {
      id: 'chapter-1',
      title: 'Series Title - Ch. 1',
      sourceUrl: 'https://example.com/chapter/1',
      relativePath: ['Series Title', 'English', 'Vol. 01', 'Ch. 01 - Intro'],
      metadata: {
        ComicInfo: {
          Series: 'Series Title',
          Title: 'Ch. 01 - Intro',
          Number: '1',
          Volume: '1',
          LanguageISO: 'en',
          PageCount: 20
        }
      }
    }
  ]
};
```

- `isSeries`: Set to `true` to declare a series result.
- `rootRelativePath`: Array of directory segments for the series root folder under `libraryPath`.
- `metadata`: Optional metadata written directly to the series root folder.
- `cover`: Optional cover image downloaded directly into the series root folder.
- `folders`: Optional array of intermediate or auxiliary folders (`{ relativePath, metadata }`). QuiviT writes metadata directly into each folder.
- `chapters`: Array of chapter stubs. Each entry requires `id`, `sourceUrl`, and `relativePath`. When `metadata` is included, QuiviT writes it directly into the chapter folder. When opening an unresolved chapter, QuiviT calls `extract()` on the chapter's `sourceUrl` and refreshes its metadata on resolution.

### External chapters

A chapter stub may point at another provider instead of hosted pages. Set the stub's `sourceUrl` to the external URL and mark the folder and title so readers can tell where the pages come from. Opening the stub resolves it through whichever entry matches that URL, so the stub author never reimplements the other provider. The MangaDex extractor uses this for MangaPlus pointers, suffixed ` (MANGA Plus)`. Stubs pointing at hosts no entry covers are skipped.

When a site exposes hosted and external chapters through separate listings, merge the passes and dedupe by chapter id. MangaDex needs this because its hosted feed and its external-link feed return disjoint sets.

### Folder metadata model

QuiviT uses direct 1:1 folder metadata lookups. It checks only the active folder for metadata files (`comicinfo.json`, `comicinfo.xml`, `meta.json`, `comet.xml`, `metadata.opf`) without parent directory inheritance or recursive scans.

Extractors supply tailored metadata directly for each folder tier:

| Field | Series root `{Series}/` | Language `{Series}/{Lang}/` | Volume `.../Vol. {X}/` | Chapter `.../Ch. {Y}/` | Standalone / Art collection |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Series` | Yes | Yes | Yes | Yes | Yes |
| `Title` | Omitted | `"{Series} ({Lang})"` | `"Volume {X}"` | `"Ch. {Y} - {Title}"` | `"{Series} (Covers)"` |
| `Volume` | Omitted | Omitted | `"{X}"` | `"{X}"` | Omitted |
| `Number` | Omitted | Omitted | Omitted | `"{Y}"` | Omitted |
| `LanguageISO` | Omitted | `"{code}"` | `"{code}"` | `"{code}"` | Omitted |
| `Translator` | Omitted | Omitted | Omitted | `"{Scanlator}"` | Omitted |
| `Notes` | Omitted | Omitted | Omitted | `"Scanlation: ..."` | Omitted |
| `PageCount` | Omitted | Omitted | Omitted | `"{count}"` | Omitted |
| `Web` | Series URL | Series URL | Series URL | Chapter URL | Source URL |
| `Summary` | Series synopsis | Series synopsis | Series synopsis | Series synopsis | Collection synopsis |
| `Tags` | Series tags | Series tags | Series tags | Series tags | `"Cover Gallery, Artbook"` |
| `Genre` | Yes | Yes | Yes | Yes | Yes |
| `Demographic` | Yes | Yes | Yes | Yes | Yes |
| `Writer` | Yes | Yes | Yes | Yes | Yes |
| `Penciller` | Yes | Yes | Yes | Yes | Yes |
| `Year` | Yes | Yes | Yes | Yes | Yes |
| `Status` | Yes | Yes | Yes | Yes | Yes |
| `Manga` | Yes | Yes | Yes | Yes | Yes |

### Safety rules

- Extractors must be pure data parsers. Import only relative branch files declared in the header. Do not import external packages, touch window globals, or mutate DOM.
- Path segments and filenames must not contain path separators (`/` or `\`), traversal segments (`..`), or Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
- File extensions must be supported media formats: `jpg`, `jpeg`, `png`, `gif`, `webp`, `apng`, `avif`, `svg`, `bmp`, `ico`, or `mp4`.
- Duplicate filenames within one gallery are rejected.

## Verified test galleries

The following sample galleries are verified working in QuiviT and serve as reference test suites to track provider features, format support, and URL routing edge cases:

| Provider | Test Target | Import Type | Library Destination | Verified Behavior |
| :--- | :--- | :--- | :--- | :--- |
| Imgur | [Anime Reaction Gifs](https://imgur.com/gallery/anime-reaction-gifs-ADdqF) | Gallery (50 GIFs) | `Imgur/Anime Reaction Gifs/` | Large animation batch, download concurrency, prefetch threshold |
| Imgur | [Azuma - Seihantai](https://imgur.com/a/azuma-seihantai-17vF37d) | Album (41 PNGs) | `Imgur/Azuma - Seihantai/` | Album `/a/` route, multi-image manga set, description sanitization |
| Imgur | [Witch Watch OP clips](https://imgur.com/gallery/just-some-witch-watch-op-clips-2Bi48Dm#/t/anime) | Gallery (8 MP4s) | `Imgur/Just some Witch Watch OP clips/` | Video extraction, audio stream detection, hashtag route (`#/t/anime`) |
| Imgur | [Direct image sample](https://i.imgur.com/4Q6rSDi.png) | Direct Media | `Imgur/4Q6rSDi.png` | Direct CDN URL (`i.imgur.com`), gallery match lookup, root sidecar recording |
| MangaDex | [Akebi-chan no Sailor Fuku (Chapters)](https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku?tab=chapters) | Multi-Chapter Series | `MangaDex/Akebi-chan no Sailor Fuku/{Language}/{Volume}/{Chapter}/` | Series `/title/{id}` route with `?tab=chapters`, feed pagination, volume hierarchy, 5-tier folder metadata sidecars |
| MangaDex | [【Oshi no Ko】 (Chapters)](https://mangadex.org/title/296cbc31-af1a-4b5b-a34b-fee2b4cad542/-oshi-no-ko?tab=chapters) | Multi-Chapter Series with MangaPlus externals | `MangaDex/【Oshi no Ko】/{Language}/{Volume}/{Chapter}/` | Hosted plus external-link feed merge, MangaPlus stubs with ` (MANGA Plus)` suffix, lazy resolution through the MangaPlus entry |
| MangaDex | [Akebi-chan no Sailor Fuku, Ch. 1](https://mangadex.org/chapter/0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d) | Single Chapter (33 JPGs) | `MangaDex/Akebi-chan no Sailor Fuku - Vol. 1 Ch. 1/` | Chapter `/chapter/{id}` route, `@home` coordinates, ComicInfo metadata sidecar |
| MangaDex | [Akebi-chan no Sailor Fuku (Covers)](https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku?tab=art) | Art Collection (Covers) | `MangaDex/Akebi-chan no Sailor Fuku (Covers)/Cover.jpg` + `{Language}/` | Art gallery `/title/{id}?tab=art`, multi-locale pagination, root `Cover.jpg`, volume filenames, root loose cover cleanup |
| MangaDex | [Akebi-chan no Sailor Fuku - Vol. 16 Cover](https://mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg) | Direct Media | `MangaDex/Akebi-chan no Sailor Fuku - Vol. 16 Cover.jpg` | Direct cover URL `/covers/{mangaId}/{fileName}`, friendly API title resolution, root `gallery.json` deduplication |
| MangaDex | [Reader blob URL](blob:https://mangadex.org/a357d5db-d810-4566-b0aa-cba411aa9460) | Unsupported URL | *None (Rejected)* | Browser ephemeral blob URL detection, descriptive rejection guiding user to chapter link |

## Authoring and testing workflow

Maintainers work on this branch through a Git worktree:

```bash
git worktree add ../quivi-t-extractors extractors
```

When changing an extractor:
1. Update or create the `<site>.js` script.
2. Bump the extractor's `version` integer in `manifest.json`. If you touched `shared/`, bump every entry that depends on it.
3. Commit both files together in a single commit on this branch.
4. Push the branch to `origin extractors`.
