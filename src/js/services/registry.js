/**
 * registry.js
 * Catalog of available filters and scalers.
 */

import { filter as anime4kFilter } from './filters/anime4k.js';
import { filter as crtFilter } from './filters/crt.js';
import { filter as phosphorFilter } from './filters/phosphor.js';
import { filter as scanlinesFilter } from './filters/scanlines.js';

export const FILTERS = [
  { id: 'anime4k', label: 'Anime4K', actionId: 'cmd-toggle-anime4k-filter', module: anime4kFilter },
  { id: 'crt', label: 'Retro CRT', actionId: 'cmd-toggle-crt-filter', module: crtFilter },
  { id: 'phosphor', label: 'Phosphor', actionId: 'cmd-toggle-phosphor-filter', module: phosphorFilter },
  { id: 'scanlines', label: 'Scanlines', actionId: 'cmd-toggle-scanlines-filter', module: scanlinesFilter }
];

export const SCALERS = [
  { id: 'none', label: 'Pixelated', actionId: 'cmd-scale-none' },
  { id: 'bilinear', label: 'Bilinear', actionId: 'cmd-scale-bilinear' },
  { id: 'lanczos', label: 'Lanczos', pipeline: 'lanczos', actionId: 'cmd-scale-lanczos' }
];

export const FILTER_BY_ID = new Map(FILTERS.map(f => [f.id, f]));

export function activeFilterId(frontendData) {
  return FILTER_BY_ID.has(frontendData.active_filter) ? frontendData.active_filter : null;
}

export function getFilterModule(id, frontendData = {}) {
  const f = FILTER_BY_ID.get(id);
  if (!f) return null;
  return f.module.resolve ? (f.module.resolve(frontendData.filter_options) ?? f.module) : f.module;
}
