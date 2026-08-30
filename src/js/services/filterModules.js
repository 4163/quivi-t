import { filter as anime4kFilter } from './filters/anime4k.js';
import { filter as crtFilter } from './filters/crt.js';
import { filter as phosphorFilter } from './filters/phosphor.js';
import { filter as scanlinesFilter } from './filters/scanlines.js';
import { FILTER_BY_ID } from './registry.js';

export function getFilterModule(id, frontendData = {}) {
  const f = FILTER_BY_ID.get(id);
  if (!f) return null;
  
  let module = null;
  switch (id) {
    case 'anime4k': module = anime4kFilter; break;
    case 'crt': module = crtFilter; break;
    case 'phosphor': module = phosphorFilter; break;
    case 'scanlines': module = scanlinesFilter; break;
  }
  if (!module) return null;
  
  return module.resolve ? (module.resolve(frontendData.filter_options) ?? module) : module;
}
