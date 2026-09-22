# QuiviT website extractors

Orphan branch hosting the runtime extractor registry for QuiviT web imports. Extractors are fetched, cached, and loaded as dynamic ES modules at runtime, so site support ships without a desktop release.

## Runtime flow

1. User pastes a URL via Open URL (`Ctrl+I`).
2. `urlLoader.js` fetches `manifest.json` from this branch, matches the URL against `patterns`.
3. The matched extractor script is downloaded, cached under `%LOCALAPPDATA%/QuiviT/extractor-cache/`, and loaded as an ES module.
4. The extractor returns image URLs and gallery metadata. QuiviT downloads images to the user's Library under `libraryPath`.

## Branch layout

```
manifest.json          Registry: id, patterns, version, source path
imgur.js               Imgur albums, galleries, direct CDN images
mangadex.js            MangaDex chapters, titles, covers, @home network images
mangaplus.js           MANGA Plus viewer chapters, title series, signed CDN images
kmanga.js              K-Manga episodes, title series, signed CDN images
shared/
  sanitize.js          Path segment sanitization
  mangaplus.js         MANGA Plus protobuf viewer client (shared by mangadex.js and mangaplus.js)
  kmanga.js            K-Manga viewer client, auth hash, tile order (shared by mangadex.js and kmanga.js)
  proto.js             Minimal protobuf varint/length-delimited decoder
README.md              This contract
```

## Manifest schema

Each entry in `manifest.json` registers one extractor. The file itself is the source of truth for live entries and patterns. The shape:

```json
{
  "version": 1,
  "extractors": [
    {
      "id": "imgur",
      "name": "Imgur",
      "libraryPath": "Imgur",
      "version": 2,
      "source": "imgur.js",
      "patterns": ["^https?://..."]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | Lower-case letters, numbers, hyphens. Unique. |
| `name` | Human-readable label shown in status UI. |
| `libraryPath` | Top-level directory name under the user's Library. |
| `version` | Positive integer. Bump on every script change to bust the client module cache. |
| `source` | Relative `.js` filename. Path traversal rejected. |
| `patterns` | Regex strings tested against user URLs. First match wins across all entries. |

## Verified test galleries

Reference URLs for manual testing. Each row covers a distinct URL route or extraction behavior.

| Provider | Test target | Import type | Library destination | Verified behavior |
|:---|:---|:---|:---|:---|
| Imgur | [Azuma - Seihantai](https://imgur.com/a/azuma-seihantai-17vF37d) | Album (41 PNGs) | `Imgur/Azuma - Seihantai/` | Album `/a/` route, multi-image manga set, description sanitization |
| Imgur | [Anime Reaction Gifs](https://imgur.com/gallery/anime-reaction-gifs-ADdqF) | Gallery (50 GIFs) | `Imgur/Anime Reaction Gifs/` | Large animation batch, download concurrency, prefetch threshold |
| Imgur | [Witch Watch OP clips](https://imgur.com/gallery/just-some-witch-watch-op-clips-2Bi48Dm#/t/anime) | Gallery (8 MP4s) | `Imgur/Just some Witch Watch OP clips/` | Video extraction, audio stream detection, hashtag route (`#/t/anime`) |
| Imgur | [Direct image sample](https://i.imgur.com/4Q6rSDi.png) | Direct media | `Imgur/4Q6rSDi.png` | Direct CDN URL (`i.imgur.com`), gallery match lookup, root sidecar recording |
| MangaDex | [Akebi-chan no Sailor Fuku (Chapters)](https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku?tab=chapters) | Multi-chapter series | `MangaDex/Akebi-chan no Sailor Fuku/{Language}/{Volume}/{Chapter}/` | Series `/title/{id}` route with `?tab=chapters`, feed pagination, volume hierarchy, 5-tier folder metadata |
| MangaDex | [Oshi no Ko (Chapters)](https://mangadex.org/title/296cbc31-af1a-4b5b-a34b-fee2b4cad542/-oshi-no-ko?tab=chapters) | Series with MANGA Plus externals | `MangaDex/【Oshi no Ko】/{Language}/{Volume}/{Chapter}/` | Hosted + external feed merge, MANGA Plus stubs with ` (MANGA Plus)` suffix, lazy resolution |
| MangaDex | [Akebi-chan Ch. 1](https://mangadex.org/chapter/0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d) | Single chapter (33 JPGs) | `MangaDex/Akebi-chan no Sailor Fuku - Vol. 1 Ch. 1/` | Chapter `/chapter/{id}` route, `@home` delivery, ComicInfo sidecar |
| MangaDex | [Akebi-chan (Covers)](https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku?tab=art) | Art collection | `MangaDex/Akebi-chan no Sailor Fuku (Covers)/` | Art `/title/{id}?tab=art`, multi-locale pagination, root cover, volume filenames |
| MangaDex | [Akebi-chan Vol. 16 Cover](https://mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg) | Direct media | `MangaDex/Akebi-chan no Sailor Fuku - Vol. 16 Cover.jpg` | Direct cover URL `/covers/{id}/{file}`, API title resolution, root `gallery.json` dedup |
| MangaDex | [Akebi-chan Vol. 16 Cover resized](https://mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg.512.jpg) | Direct media | `MangaDex/Akebi-chan no Sailor Fuku - Vol. 16 Cover.jpg` | Sized variant normalizes to the canonical file, links the art-collection copy |
| MangaDex | [Reader blob:https:// URL](blob:https://mangadex.org/a357d5db-d810-4566-b0aa-cba411aa9460) | Unsupported | *Rejected* | Blob URL detection, descriptive rejection guiding user to chapter link |
| MANGA Plus | [SPY x FAMILY (Chapters)](https://mangaplus.shueisha.co.jp/titles/100056) | Title series | `MangaPlus/SPY x FAMILY (English)/{Chapter}/` | Series `titles/{id}` route via `title_detailV3`, language root, cover, lazy chapter stubs |
| MANGA Plus | [SPY x FAMILY Ch. 1](https://mangaplus.shueisha.co.jp/viewer/1001834) | Single chapter | `MangaPlus/SPY x FAMILY - Ch. 1 (English)/` | Chapter `viewer/{id}` via `manga_viewer_v3`, XOR decrypt, `Plus-Vw-Token` headers |
| MANGA Plus | [SPY x FAMILY thumbnail](https://jumpg-assets.tokyo-cdn.com/secure/title/100056/title_thumbnail_portrait_list/313744.jpg?hash=ktoQqLjO4TO9hZz8kWFCvQ&expires=2145884400) | Direct media | `MangaPlus/SPY x FAMILY - 313744 (English).jpg` | Signed CDN URL preserved, friendly filename via title detail with hashed fallback |
| K-Manga | [K-Manga episode](https://kmanga.kodansha.com/title/10072/episode/311334) | Single episode (74 JPGs) | `KManga/Attack on Titan - Episode 01/` | Episode `title/{id}/episode/{id}` route, tile-grid descramble, auth hash, viewer API |
| K-Manga | [K-Manga title](https://kmanga.kodansha.com/title/10072) | Title series | `KManga/Attack on Titan/{Episode}/` | Series `title/{id}` route, HTML metadata, lazy episode stubs |
| K-Manga | [K-Manga CDN image](https://cdn.kmanga.kodansha.com/path/to/image.jpg?token=abc) | Direct media | `KManga/kmanga-image.jpg` | Signed CDN URL preserved, hashed fallback filename |
| MangaDex | [Series with K-Manga externals](https://mangadex.org/title/{id}?tab=chapters) | Series with K-Manga externals | `MangaDex/{Title}/{Language}/{Volume}/{Chapter} (K-Manga)/` | K-Manga stubs with ` (K-Manga)` suffix, lazy resolution through kmanga.js |

## Module contract

An extractor is an ES module. Two exports are required, two are optional.

### Exports

| Export | Required | Signature | Purpose |
|---|---|---|---|
| `match` | yes | `(url) => bool` | Returns `true` if this extractor handles the URL. |
| `extract` | yes | `(html, url, context) => result` | Parses a page and returns a gallery or series result. |
| `isDirectUrl` | no | `(url) => bool` | Returns `true` for direct media URLs (CDN images, covers). The app skips the HTML fetch and routes through `parseDirectUrl`. |
| `parseDirectUrl` | no | `(url, context) => { provider, hash, filename, url } \| null` | Resolves a direct media URL. `hash` deduplicates against Library sidecars. Returning `null` falls through to `extract`. Resized variants (such as MangaDex `file.jpg.512.jpg` covers) normalize to the canonical file so they link their gallery copies, while the download still uses the pasted address. |

`context` provides `fetchText(url)`, and when declared, `fetchBytes(url)` and `requestHeaders`.

### Header directives

Extractors declare dependencies and capabilities in their first two lines:

```js
// quivit-deps: shared/sanitize.js, shared/mangaplus.js
// quivit-needs: fetchBytes, requestHeaders, xorDecrypt
```

**Dependencies** (`quivit-deps`): The loader fetches listed files from this branch, follows their sub-dependencies, and rewrites imports at load time. Every relative import must appear in the header. `shared/mangaplus.js` transitively pulls `shared/proto.js` without the entry needing to list it.

**Capabilities** (`quivit-needs`): If the running QuiviT build does not support a named capability, loading fails fast with an update message.

| Capability | What it provides |
|---|---|
| `fetchBytes` | Binary fetch returning bytes (protobuf, binary payloads). |
| `requestHeaders` | Custom headers on fetch and download (session tokens, view tokens). |
| `xorDecrypt` | Per-image `{ algorithm: 'xor', key }` descriptors, decrypted before save. |
| `tileDescramble` | Per-image `{ algorithm: 'tile-grid', cols, rows, order }` descriptors. The backend decodes the image, rearranges tiles per the permutation, and re-encodes before save. |

### Safety rules

- Pure data parsers only. No external packages, no `window` globals, no DOM.
- Path segments and filenames must not contain `/`, `\`, `..`, or Windows reserved device names.
- File extensions must be supported formats: `jpg`, `jpeg`, `png`, `gif`, `webp`, `apng`, `avif`, `svg`, `bmp`, `ico`, `mp4`.
- Duplicate filenames within one gallery are rejected.
- Shared files must not export `match` or `extract`, and are never added to the manifest.

## Return shapes

`extract` returns one of two shapes: a single gallery or a series.

### Single gallery

```js
{
  provider: 'Example',         // must match manifest name
  title: 'Gallery Title',
  gallery: {
    id: 'gallery-123',         // stable site-unique id
    relativePath: ['Category', 'Gallery Title']  // path segments under libraryPath, max depth 8
  },
  images: [
    { url: 'https://cdn.example.com/001.jpg', filename: '001.jpg' }
  ],
  metadata: {                  // optional, written as comicinfo.json
    ComicInfo: { Series: 'Name', Title: 'Gallery Title', Summary: '...' }
  },
  targetFilename: '005.jpg',   // optional: eager-download this image, open viewer on it
  nextPageUrl: null             // next page URL or null; consecutive pages share gallery.id and relativePath
}
```

An image may name prior standalone files it absorbs:

```js
{ url: 'https://cdn.example.com/00.png', filename: '00.png', supersedes: ['https://cdn.example.com/thumb.png'] }
```

When the gallery imports, each absorbed standalone is deleted, file plus its Library records. Use this when the gallery renames a previously imported direct URL, such as a thumbnail arriving as page zero. List addresses or stems; matching tries exact address first, then stems.

`metadata` serialization: an object writes `comicinfo.json`. A string starting with `<` writes `comicinfo.xml`. An object with `{ filename, content }` writes a custom file.

### Series

Series results index multi-chapter manga. Chapters are stubs resolved lazily when opened.

```js
{
  provider: 'Example',
  isSeries: true,
  title: 'Series Title',
  rootRelativePath: ['Series Title'],     // series root under libraryPath
  metadata: { ComicInfo: { ... } },       // optional, written to the root folder
  cover: { url: '...', filename: 'Cover.jpg' },  // optional, downloaded into root
  folders: [                              // optional intermediate folders with metadata
    { relativePath: ['Series Title', 'English'], metadata: { ... } }
  ],
  chapters: [
    {
      id: 'ch-1',                         // stable chapter id
      title: 'Ch. 1 - Intro',
      sourceUrl: 'https://example.com/chapter/1',  // resolved via extract() when opened
      relativePath: ['Series Title', 'English', 'Vol. 01', 'Ch. 01 - Intro'],
      cover: { url: '...', filename: 'Ch. 1 Cover.png' },  // optional, downloaded next to the stub
      metadata: { ComicInfo: { ... } }    // optional, written to the chapter folder
    }
  ]
}
```

Opening an unresolved chapter calls `extract()` on its `sourceUrl` and refreshes its metadata on resolution.

### Cross-provider chapters

A chapter stub can point at another provider's URL. The app resolves it through whichever manifest entry matches that URL. The stub author never reimplements the other site's extractor. MangaDex uses this for MANGA Plus pointers (suffixed ` (MANGA Plus)`) and K MANGA pointers (suffixed ` (K MANGA)`). Stubs pointing at unmatched hosts are skipped.

When a site exposes hosted and external chapters through separate feeds, merge them and dedupe by chapter id. MangaDex needs this because its hosted feed and external-link feed return disjoint sets.

### Clearing and jumping

These rules are the same for every site. The extractor declares facts, the app decides.

Clearing means deleted: the file plus its Library records. A series import removes standalone chapter folders it absorbs. A gallery import removes absorbed standalone files named in `supersedes`. Finished chapters and covers are never touched by a re-import. There is no file relocation.

Jumping picks where an import lands. A gallery copy beats a loose standalone, which beats a series cover. Inside each tier, an exact address match beats a stem match. `targetFilename` names the open target and wins over everything. Otherwise the open-first-image setting governs.

## Folder metadata model

QuiviT reads metadata per folder with no parent inheritance. Extractors supply tailored metadata at each tier:

| Field | Series root | Language | Volume | Chapter | Standalone / Art |
|:---|:---|:---|:---|:---|:---|
| `Series` | Yes | Yes | Yes | Yes | Yes |
| `Title` | Omitted | `"{Series} ({Lang})"` | `"Volume {X}"` | `"Ch. {Y} - {Title}"` | `"{Series} (Covers)"` |
| `Volume` | Omitted | Omitted | `"{X}"` | `"{X}"` | Omitted |
| `Number` | Omitted | Omitted | Omitted | `"{Y}"` | Omitted |
| `LanguageISO` | Omitted | `"{code}"` | `"{code}"` | `"{code}"` | Omitted |
| `Translator` | Omitted | Omitted | Omitted | `"{Scanlator}"` | Omitted |
| `Notes` | Omitted | Omitted | Omitted | `"Scanlation: ..."` | Omitted |
| `PageCount` | Omitted | Omitted | Omitted | `"{count}"` | Omitted |
| `Web` | Series URL | Series URL | Series URL | Chapter URL | Source URL |
| `Summary` | Synopsis | Synopsis | Synopsis | Synopsis | Collection synopsis |
| `Tags` | Series tags | Series tags | Series tags | Series tags | `"Cover Gallery, Artbook"` |
| `Genre` | Yes | Yes | Yes | Yes | Yes |
| `Demographic` | Yes | Yes | Yes | Yes | Yes |
| `Writer` | Yes | Yes | Yes | Yes | Yes |
| `Penciller` | Yes | Yes | Yes | Yes | Yes |
| `Year` | Yes | Yes | Yes | Yes | Yes |
| `Status` | Yes | Yes | Yes | Yes | Yes |
| `Manga` | Yes | Yes | Yes | Yes | Yes |

## Authoring workflow

Work on this branch through a Git worktree:

```bash
git worktree add ../quivi-t-extractors extractors
```

When changing an extractor:
1. Update or create the `<site>.js` script.
2. Bump the extractor's `version` integer in `manifest.json`. If you touched `shared/`, bump every entry that depends on it.
3. Commit both files together in a single commit on this branch.
4. Push the branch to `origin extractors`.
