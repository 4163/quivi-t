/**
 * registry.js
 * Catalog of available filters and scalers.
 */

export const FILTERS = [
  { id: 'anime4k', label: 'Anime4K', actionId: 'cmd-toggle-anime4k-filter' },
  { id: 'crt', label: 'Retro CRT', actionId: 'cmd-toggle-crt-filter' },
  { id: 'phosphor', label: 'Phosphor', actionId: 'cmd-toggle-phosphor-filter' },
  { id: 'scanlines', label: 'Scanlines', actionId: 'cmd-toggle-scanlines-filter' }
];

export const SCALERS = [
  { id: 'none', label: 'Pixelated', css: 'pixelated', actionId: 'cmd-scale-none' },
  { id: 'bilinear', label: 'Bilinear', css: 'auto', actionId: 'cmd-scale-bilinear' },
  { id: 'lanczos', label: 'Lanczos', pipeline: 'lanczos', actionId: 'cmd-scale-lanczos' }
];

export const FILTER_BY_ID = new Map(FILTERS.map(f => [f.id, f]));

export function activeFilterId(frontendData) {
  return FILTER_BY_ID.has(frontendData.active_filter) ? frontendData.active_filter : null;
}
