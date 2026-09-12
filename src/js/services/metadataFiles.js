export const METADATA_FILENAMES = [
  'comicinfo.xml',
  'comicinfo.json',
  'meta.json',
  'comet.xml',
  'comet.json',
  'metadata.opf',
];

function metadataBareName(name) {
  return String(name || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

export function isMetadataEntryName(name) {
  return METADATA_FILENAMES.includes(metadataBareName(name));
}

export function findMetadataEntry(fileNames) {
  for (const target of METADATA_FILENAMES) {
    const match = fileNames.find(n => metadataBareName(n) === target);
    if (match) return match;
  }
  return null;
}
