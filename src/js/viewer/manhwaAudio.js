import { BoundedMap } from '../services/cache.js';

/**
 * manhwaAudio.js: per slot volume for strip videos.
 *
 * Owns pill UI plus audio state. The strip owns slots and calls attach and
 * detach around its claim and release paths. Legacy viewerAudio.js stays
 * untouched and serves single view only. Video elements carry their own
 * sound; no shared audio element can serve N slots.
 */

const AUDIO_STATE_CACHE_CAPACITY = 500;
const TRACK_CACHE_CAPACITY = 500;
const DEFAULT_VOLUME = 0.5;
const DEFAULT_MUTED = true;

const _fileAudioMap = new BoundedMap(AUDIO_STATE_CACHE_CAPACITY);
const _audioTrackCache = new BoundedMap(TRACK_CACHE_CAPACITY);

/** imgIdx -> { videoNode, pill, btn, slider, filePath }. */
const _attached = new Map();
/** imgIdx of the one unmuted slot. Null when all muted. */
let _audibleImgIdx = null;

let _Core = null;
let _FsUtils = null;

function _fileKey(item) {
  return item?.entry?.path || item?.entry?.name || '';
}

function _getFileAudioState(filePath) {
  if (filePath && _fileAudioMap.has(filePath)) {
    return _fileAudioMap.get(filePath);
  }
  return { muted: DEFAULT_MUTED, volume: DEFAULT_VOLUME };
}

function _saveFileAudioState(filePath, state) {
  if (!filePath) return;
  _fileAudioMap.set(filePath, {
    muted: Boolean(state.muted),
    volume: typeof state.volume === 'number' ? state.volume : DEFAULT_VOLUME,
  });
}

function _paint(rec) {
  if (!rec?.btn || !rec?.slider) return;
  const { muted, volume } = _getFileAudioState(rec.filePath);
  rec.btn.setAttribute('aria-label', muted ? 'Unmute Audio' : 'Mute Audio');
  if (muted) {
    rec.btn.setAttribute('data-state', 'muted');
  } else if (volume <= 0) {
    rec.btn.setAttribute('data-state', 'zero');
  } else if (volume < 0.5) {
    rec.btn.setAttribute('data-state', 'low');
  } else {
    rec.btn.setAttribute('data-state', 'high');
  }
  rec.slider.value = volume;
}

function _applyToNode(rec) {
  if (!rec?.videoNode) return;
  const { muted, volume } = _getFileAudioState(rec.filePath);
  rec.videoNode.muted = muted;
  rec.videoNode.volume = volume;
}

function _muteOthers(exceptImgIdx) {
  for (const [idx, rec] of _attached) {
    if (idx === exceptImgIdx) continue;
    const cur = _getFileAudioState(rec.filePath);
    if (!cur.muted) {
      _saveFileAudioState(rec.filePath, { muted: true, volume: cur.volume });
      _applyToNode(rec);
      _paint(rec);
    }
  }
}

export function toggleSlotMute(imgIdx) {
  const rec = _attached.get(imgIdx);
  if (!rec) return;
  const cur = _getFileAudioState(rec.filePath);
  const nextMuted = !cur.muted;
  let nextVolume = cur.volume;
  if (!nextMuted && nextVolume <= 0) nextVolume = DEFAULT_VOLUME;
  _saveFileAudioState(rec.filePath, { muted: nextMuted, volume: nextVolume });
  if (!nextMuted) {
    _muteOthers(imgIdx);
    _audibleImgIdx = imgIdx;
  } else if (_audibleImgIdx === imgIdx) {
    _audibleImgIdx = null;
  }
  _applyToNode(rec);
  _paint(rec);
}

export function setSlotVolume(imgIdx, volume) {
  const rec = _attached.get(imgIdx);
  if (!rec) return;
  const next = Math.max(0, Math.min(1, volume));
  const cur = _getFileAudioState(rec.filePath);
  const unmuted = next > 0 && cur.muted;
  _saveFileAudioState(rec.filePath, { muted: unmuted ? false : cur.muted, volume: next });
  if (unmuted) {
    _muteOthers(imgIdx);
    _audibleImgIdx = imgIdx;
  }
  _applyToNode(rec);
  _paint(rec);
}

export function stepSlotVolume(imgIdx, delta) {
  const rec = _attached.get(imgIdx);
  if (!rec) return;
  const cur = _getFileAudioState(rec.filePath);
  const next = Math.round((cur.volume + delta) * 100) / 100;
  setSlotVolume(imgIdx, next);
}

function _buildPill(slot, rec) {
  const template = document.getElementById('manhwa-volume-template');
  const pill = template?.content?.firstElementChild?.cloneNode(true);
  if (!pill) return null;
  const btn = pill.querySelector('.manhwa-volume-toggle');
  const slider = pill.querySelector('.manhwa-volume-slider');
  if (!btn || !slider) return null;
  rec.pill = pill;
  rec.btn = btn;
  rec.slider = slider;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSlotMute(rec.imgIdx);
    // Pointer clicks park focus and pin the popover open through
    // focus-within. Keyboard activation (detail 0) keeps its focus.
    if (e.detail > 0) btn.blur();
  });
  slider.addEventListener('input', (e) => {
    setSlotVolume(rec.imgIdx, parseFloat(e.target.value));
  });
  slider.addEventListener('pointerup', () => slider.blur());
  pill.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  pill.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stepSlotVolume(rec.imgIdx, e.deltaY < 0 ? 0.05 : -0.05);
  }, { passive: false });
  slot.appendChild(pill);
  return pill;
}

async function _probeTrack(rec) {
  const liveState = _Core?.getState?.();
  const archivePath = liveState?.mode === 'archive' ? liveState.archivePath : null;
  let hasAudio = false;
  if (_audioTrackCache.has(rec.filePath)) {
    hasAudio = _audioTrackCache.get(rec.filePath);
  } else if (_FsUtils?.checkMediaAudio) {
    hasAudio = await _FsUtils.checkMediaAudio(rec.filePath, archivePath);
    _audioTrackCache.set(rec.filePath, hasAudio);
  }
  // Slot moved on while probing: drop it.
  const live = _attached.get(rec.imgIdx);
  if (!live || live.videoNode !== rec.videoNode) return;
  if (!hasAudio) {
    live.pill?.remove();
    live.pill = null;
    return;
  }
  live.pill?.classList.add('is-visible');
}

export function attachSlotAudio(imgIdx, item, slot, videoNode) {
  detachSlotAudio(imgIdx);
  const filePath = _fileKey(item);
  if (!filePath || !slot || !videoNode) return;
  const rec = { imgIdx, videoNode, filePath, pill: null, btn: null, slider: null };
  _attached.set(imgIdx, rec);
  _applyToNode(rec);
  if (!_buildPill(slot, rec)) {
    _attached.delete(imgIdx);
    return;
  }
  _paint(rec);
  _probeTrack(rec);
}

export function detachSlotAudio(imgIdx, { reset = false } = {}) {
  const rec = _attached.get(imgIdx);
  if (!rec) return;
  if (reset) {
    // Out of view means muted again on return. Rebinds within the same slot
    // keep state and pass no reset.
    const cur = _getFileAudioState(rec.filePath);
    _saveFileAudioState(rec.filePath, { muted: true, volume: cur.volume });
  }
  rec.pill?.remove();
  _attached.delete(imgIdx);
  if (_audibleImgIdx === imgIdx) _audibleImgIdx = null;
}

/**
 * Strip `m` behavior. Anything audible mutes everything. All muted unmutes
 * the anchor video exclusively. Anything else does nothing.
 */
export function toggleStripMute(anchorImgIdx) {
  let anyAudible = false;
  for (const [, rec] of _attached) {
    if (!_getFileAudioState(rec.filePath).muted) {
      anyAudible = true;
      break;
    }
  }
  if (anyAudible) {
    _muteOthers(null);
    _audibleImgIdx = null;
    return;
  }
  const rec = _attached.get(anchorImgIdx);
  if (!rec) return;
  const cur = _getFileAudioState(rec.filePath);
  _saveFileAudioState(rec.filePath, {
    muted: false,
    volume: cur.volume > 0 ? cur.volume : DEFAULT_VOLUME,
  });
  _audibleImgIdx = anchorImgIdx;
  _applyToNode(rec);
  _paint(rec);
}

export function initManhwaAudio({ Core, FsUtils }) {
  _Core = Core;
  _FsUtils = FsUtils;
}

export const ManhwaAudio = {
  attach: attachSlotAudio,
  detach: detachSlotAudio,
  toggleMute: toggleSlotMute,
  setVolume: setSlotVolume,
  stepVolume: stepSlotVolume,
  toggleStripMute,
};
