import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, '../..');
export const testFilesRoot = path.resolve(projectRoot, 'test-files');
export const archivesDir = path.resolve(testFilesRoot, '_archives');

export const fixtures = {
  root: testFilesRoot,
  archivesDir,

  // Direct images
  testPng: path.resolve(testFilesRoot, 'export_1785518878919.png'),
  testSpread: path.resolve(testFilesRoot, 'spread_test_white.png'),
  testBmp: path.resolve(testFilesRoot, 'BDレーベル.bmp'),
  testSvg: path.resolve(testFilesRoot, 'gfl-spinner.svg'),

  // Base archives
  zip: path.resolve(archivesDir, 'zip.zip'),
  cbz: path.resolve(archivesDir, 'cbz.cbz'),
  rar: path.resolve(archivesDir, 'rar.rar'),
  cbr: path.resolve(archivesDir, 'cbr.cbr'),
  sevenz: path.resolve(archivesDir, '7z.7z'),
  cb7: path.resolve(archivesDir, 'cb7.cb7'),
  tar: path.resolve(archivesDir, 'tar.tar'),
  cbt: path.resolve(archivesDir, 'cbt.cbt'),

  // Encoding fixtures
  shiftJisZip: path.resolve(archivesDir, 'encoding_tests/shift_jis_test.zip'),
  gbkZip: path.resolve(archivesDir, 'encoding_tests/gbk_test.zip'),
  eucKrZip: path.resolve(archivesDir, 'encoding_tests/euckr_test.zip'),

  // Password / encrypted archives
  encryptedZip: path.resolve(archivesDir, 'encrypted_tests/encrypted-123.zip'),
  encryptedRar: path.resolve(archivesDir, 'encrypted_tests/encrypted-123.rar'),
  corruptHeaderZip: path.resolve(archivesDir, 'encrypted_tests/corrupt_local_header.zip'),

  // Metadata fixtures
  metadata7z: path.resolve(archivesDir, 'metadata_tests/metadata.7z'),
  metadataCb7: path.resolve(archivesDir, 'metadata_tests/metadata.cb7'),
  comicInfoCbz: path.resolve(archivesDir, 'metadata_tests/ch-4-vol-4.cbz'),
};
