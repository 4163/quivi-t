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

/**
 * Resolves natural or viewBox dimensions for an SVG image, scaling down
 * by maxEdge when specified while maintaining aspect ratio. Falls back
 * to 1000x1000 if dimensions are unspecified or equal Chromium defaults (150x150, 300x150).
 * @param {number} naturalWidth
 * @param {number} naturalHeight
 * @param {string} svgText
 * @param {number} [maxEdge]
 * @returns {{ width: number, height: number }}
 */
export function resolveSvgDimensions(naturalWidth, naturalHeight, svgText, maxEdge = 0) {
  let w = naturalWidth || 0;
  let h = naturalHeight || 0;
  const isBrowserDefault = (w === 150 && h === 150) || (w === 300 && h === 150);
  if (w <= 0 || h <= 0 || isBrowserDefault) {
    const vb = typeof svgText === 'string'
      ? svgText.match(/viewBox=["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)["']/i)
      : null;
    if (vb) {
      const vbW = parseFloat(vb[3]);
      const vbH = parseFloat(vb[4]);
      if (vbW > 0 && vbH > 0) {
        w = Math.round(vbW);
        h = Math.round(vbH);
      } else {
        w = 1000;
        h = 1000;
      }
    } else {
      w = 1000;
      h = 1000;
    }
  }
  if (maxEdge > 0 && (w > maxEdge || h > maxEdge)) {
    const s = Math.min(maxEdge / w, maxEdge / h);
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  return { width: w, height: h };
}
