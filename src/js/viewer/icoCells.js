/**
 * icoCells.js: ICO per-size DOM factory.
 *
 * Owns .ico-container / .ico-size structure for legacy and strip rows.
 * Cells are per-file pipeline output, built dynamically on navigation or mount.
 */

import { computeSlotHue } from '../services/viewerMath.js';

export function mirroredGrillAngle(grillAngle) {
  return grillAngle === '45deg' ? '-45deg' : '45deg';
}

export function createIcoContainer() {
  const container = document.createElement('div');
  container.className = 'ico-container';
  return container;
}

export function createIcoCell(size, index, total, mirroredAngle) {
  const cell = document.createElement('div');
  cell.className = 'ico-size';
  const backdrop = document.createElement('div');
  backdrop.className = 'ico-size-backdrop';
  cell.appendChild(backdrop);
  const img = document.createElement('img');
  cell.appendChild(img);
  cell.style.setProperty('--ico-w', `${size.width}px`);
  cell.style.setProperty('--ico-h', `${size.height}px`);
  if (total > 1) cell.style.setProperty('--slot-backdrop-bg', computeSlotHue(index, total));
  else cell.style.removeProperty('--slot-backdrop-bg');
  cell.style.setProperty('--slot-backdrop-angle', mirroredAngle);
  return { cell, img };
}
