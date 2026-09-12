import test from 'node:test';
import assert from 'node:assert/strict';

import { applySort } from '../services/sorting.js';

test('Sorting: archive default name order keeps root files before nested files', () => {
  const list = [
    { name: '..', is_dir: true, is_parent: true },
    { name: 'aaa/01.jpg', path: 'C:\\books\\sample.zip|aaa/01.jpg', ext: 'jpg', is_dir: false },
    { name: 'z.jpg', path: 'C:\\books\\sample.zip|z.jpg', ext: 'jpg', is_dir: false },
    { name: 'a.jpg', path: 'C:\\books\\sample.zip|a.jpg', ext: 'jpg', is_dir: false },
    { name: 'bbb/01.jpg', path: 'C:\\books\\sample.zip|bbb/01.jpg', ext: 'jpg', is_dir: false },
    { name: 'sub\\02.jpg', path: 'C:\\books\\sample.zip|sub\\02.jpg', ext: 'jpg', is_dir: false },
  ];

  const sorted = applySort(list, 'name', false).map(item => item.name);

  assert.deepEqual(sorted, [
    '..',
    'a.jpg',
    'z.jpg',
    'aaa/01.jpg',
    'bbb/01.jpg',
    'sub\\02.jpg',
  ]);
});

