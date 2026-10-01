/**
 * svgUtils.js: shared utilities for SVG entity expansion and canvas sanitization.
 *
 * Invariants:
 * - Pure functions only, zero DOM dependencies.
 * - Illustrator-style internal DTD entities are safely expanded in a single
 *   non-recursive pass, preventing billion-laughs attacks while restoring styles.
 * - Strips `<foreignObject>` blocks that cause Chromium to taint 2D canvas surfaces.
 */

const SVG_ENTITY_MAX_COUNT = 500;
const SVG_ENTITY_MAX_LITERAL = 4096;
const SVG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Expands internal DTD entities (such as Adobe Illustrator style entities)
 * and strips the DOCTYPE block.
 * @param {string} text
 * @returns {string}
 */
export function expandSvgEntities(text) {
  if (typeof text !== 'string' || !text.includes('<!ENTITY')) return text;
  const doctype = text.match(/<!DOCTYPE[^[\]]*\[([\s\S]*?)\]>/);
  if (!doctype) return text;
  const subset = doctype[1];
  if (subset.includes('%') || subset.includes('SYSTEM') || subset.includes('PUBLIC')) {
    throw new Error('SVG entity block rejected');
  }
  const declared = (subset.match(/<!ENTITY/g) || []).length;
  const table = new Map();
  const simple = /<!ENTITY\s+([A-Za-z_][\w.-]*)\s+"([^"<>]*)"\s*>/g;
  let m;
  let simpleCount = 0;
  while ((m = simple.exec(subset)) !== null) {
    simpleCount++;
    if (table.size >= SVG_ENTITY_MAX_COUNT || m[2].length > SVG_ENTITY_MAX_LITERAL) {
      throw new Error('SVG entity block rejected');
    }
    if (!table.has(m[1])) table.set(m[1], m[2]);
  }
  if (simpleCount !== declared) {
    throw new Error('SVG entity block rejected');
  }
  let out = text.replace(doctype[0], '');
  if (table.size > 0) {
    const names = [...table.keys()].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    out = out.replace(new RegExp(`&(${names.join('|')});`, 'g'), (hit, name) => table.get(name));
  }
  if (out.length > SVG_MAX_BYTES) {
    throw new Error('SVG entity block rejected');
  }
  return out;
}

/**
 * Prepares an SVG string for rendering onto a canvas and WebGL texture upload.
 * Expands internal DTD entities, strips the DOCTYPE, and removes <foreignObject>
 * blocks and Illustrator private data payloads that cause Chromium to mark the
 * canvas as tainted (cross-origin).
 * @param {string} text
 * @returns {string}
 */
export function prepareSvgForCanvas(text) {
  if (typeof text !== 'string') return '';
  let out = expandSvgEntities(text);
  if (out.includes('<foreignObject') || out.includes('<foregnObject')) {
    out = out.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
  }
  if (out.includes('<i:pgf')) {
    out = out.replace(/<i:pgf[\s\S]*?<\/i:pgf>/gi, '');
  }
  return out;
}
