export function splitArchivePath(path) {
  if (typeof path !== 'string') {
    return { isArchiveEntry: false, archivePath: path || '', entryName: '' };
  }
  const sep = path.indexOf('|');
  if (sep !== -1) {
    return {
      isArchiveEntry: true,
      archivePath: path.slice(0, sep),
      entryName: path.slice(sep + 1)
    };
  }
  return {
    isArchiveEntry: false,
    archivePath: path,
    entryName: ''
  };
}

export function formatArchiveEntryPath(archivePath, entryName) {
  return `${archivePath}|${entryName}`;
}
