import { BoundedMap } from '../services/cache.js';

const AUDIO_STATE_CACHE_CAPACITY = 500;
const DEFAULT_VOLUME = 0.5;
const DEFAULT_MUTED = true;

const _fileAudioMap = new BoundedMap(AUDIO_STATE_CACHE_CAPACITY);
const _audioTrackCache = new BoundedMap(AUDIO_STATE_CACHE_CAPACITY);

let _Core = null;
let _FsUtils = null;

let _containerEl = null;
let _audioEl = null;
let _btnToggleEl = null;
let _popoverEl = null;
let _sliderEl = null;

let _currentMuted = DEFAULT_MUTED;
let _currentVolume = DEFAULT_VOLUME;
let _activeAudioPath = null;
let _hasAudioTrack = false;

function _getFileAudioState(filePath, item = null) {
  if (item && item._audioMuted !== undefined && item._audioVolume !== undefined) {
    return { muted: item._audioMuted, volume: item._audioVolume };
  }
  if (filePath && _fileAudioMap.has(filePath)) {
    return _fileAudioMap.get(filePath);
  }
  return { muted: DEFAULT_MUTED, volume: DEFAULT_VOLUME };
}

function _saveFileAudioState(filePath, state) {
  if (!filePath) return;
  const entry = {
    muted: Boolean(state.muted),
    volume: typeof state.volume === 'number' ? state.volume : DEFAULT_VOLUME
  };
  _fileAudioMap.set(filePath, entry);

  const curState = _Core?.getState?.();
  const item = curState?.list?.[curState?.index];
  if (item && (item.path === filePath || item.name === filePath)) {
    item._audioMuted = entry.muted;
    item._audioVolume = entry.volume;
  }
}

function _updateUI() {
  if (!_btnToggleEl || !_popoverEl || !_sliderEl) return;

  if (!_hasAudioTrack) {
    _btnToggleEl.disabled = true;
    _btnToggleEl.tabIndex = -1;
    _btnToggleEl.removeAttribute('title');
    _btnToggleEl.setAttribute('aria-label', 'No Audio');
    _popoverEl.classList.add('is-disabled');
    _btnToggleEl.removeAttribute('data-state');
    _sliderEl.value = _currentVolume;
    return;
  }

  _btnToggleEl.disabled = false;
  _btnToggleEl.tabIndex = 0;
  _btnToggleEl.removeAttribute('title');
  _btnToggleEl.setAttribute('aria-label', _currentMuted ? 'Unmute Audio' : 'Mute Audio');
  _popoverEl.classList.remove('is-disabled');

  if (_currentMuted) {
    _btnToggleEl.setAttribute('data-state', 'muted');
  } else if (_currentVolume <= 0) {
    _btnToggleEl.setAttribute('data-state', 'zero');
  } else if (_currentVolume < 0.5) {
    _btnToggleEl.setAttribute('data-state', 'low');
  } else {
    _btnToggleEl.setAttribute('data-state', 'high');
  }

  _sliderEl.value = _currentVolume;
}

function _applyAudioState() {
  if (!_audioEl) return;
  _audioEl.volume = _currentVolume;
  _audioEl.muted = _currentMuted;

  if (_hasAudioTrack && !_currentMuted) {
    _audioEl.play().catch(() => {});
  } else {
    _audioEl.pause();
  }
}

function _resetAudio() {
  _activeAudioPath = null;
  _hasAudioTrack = false;
  _currentMuted = DEFAULT_MUTED;
  _currentVolume = DEFAULT_VOLUME;
  if (_containerEl) {
    _containerEl.classList.remove('is-visible');
  }
  if (_audioEl) {
    _audioEl.pause();
    _audioEl.removeAttribute('src');
    _audioEl.load();
  }
  _updateUI();
}

export function toggleAudioMute() {
  if (!_hasAudioTrack || !_activeAudioPath) return;
  _currentMuted = !_currentMuted;
  if (!_currentMuted && _currentVolume <= 0) {
    _currentVolume = DEFAULT_VOLUME;
  }
  _saveFileAudioState(_activeAudioPath, { muted: _currentMuted, volume: _currentVolume });
  _applyAudioState();
  _updateUI();
}

export function setAudioVolume(volume, { unmute = true } = {}) {
  if (!_activeAudioPath) return;
  _currentVolume = Math.max(0, Math.min(1, volume));
  if (unmute && _currentVolume > 0 && _currentMuted) {
    _currentMuted = false;
  }
  _saveFileAudioState(_activeAudioPath, { muted: _currentMuted, volume: _currentVolume });
  _applyAudioState();
  _updateUI();
}

export function stepAudioVolume(delta) {
  const next = Math.round((_currentVolume + delta) * 100) / 100;
  setAudioVolume(next, { unmute: delta > 0 });
}

async function _syncAudioState(state) {
  if (state.mode === 'empty' || !state.list || state.index < 0 || state.index >= state.list.length) {
    _resetAudio();
    return;
  }

  const item = state.list[state.index];
  if (!item || item.is_dir || item.is_parent || !_FsUtils?.isVideo(item.name || item.path || '')) {
    _resetAudio();
    return;
  }

  if (_containerEl) {
    _containerEl.classList.add('is-visible');
  }

  const filePath = item.path;
  if (filePath === _activeAudioPath) return;
  _activeAudioPath = filePath;

  const fileAudio = _getFileAudioState(filePath, item);
  _currentMuted = fileAudio.muted;
  _currentVolume = fileAudio.volume;

  if (_audioEl) {
    _audioEl.pause();
    _audioEl.removeAttribute('src');
  }

  let hasAudio = false;
  if (_audioTrackCache.has(filePath)) {
    hasAudio = _audioTrackCache.get(filePath);
  } else if (_FsUtils?.checkMediaAudio) {
    hasAudio = await _FsUtils.checkMediaAudio(filePath, state.archivePath || null);
    _audioTrackCache.set(filePath, hasAudio);
    item.hasSound = hasAudio;
  } else if (item.hasSound !== undefined) {
    hasAudio = Boolean(item.hasSound);
  }

  // Guard against race conditions if user navigated while awaiting probe
  if (filePath !== _activeAudioPath) return;

  _hasAudioTrack = hasAudio;
  _updateUI();

  if (_hasAudioTrack && _audioEl) {
    const audioSrc = _FsUtils.buildAudioSrc(filePath);
    _audioEl.src = audioSrc;
    _audioEl.currentTime = 0;
    _audioEl.loop = true;
    _applyAudioState();
  }
}

function _syncAudioWithVideo(vEl) {
  if (!_hasAudioTrack || !_audioEl || _currentMuted) return;
  if (Math.abs(_audioEl.currentTime - vEl.currentTime) > 0.15) {
    _audioEl.currentTime = vEl.currentTime;
  }
  if (!vEl.paused && _audioEl.paused) {
    _audioEl.play().catch(() => {});
  } else if (vEl.paused && !_audioEl.paused) {
    _audioEl.pause();
  }
}

function _onWheel(e) {
  e.preventDefault();
  e.stopPropagation();
  const delta = e.deltaY < 0 ? 0.05 : -0.05;
  stepAudioVolume(delta);
}

export function initViewerAudio({ Core, FsUtils }) {
  _Core = Core;
  _FsUtils = FsUtils;

  _containerEl = document.querySelector('.audio-control-container');
  _audioEl = document.getElementById('viewer-audio');
  _btnToggleEl = document.getElementById('btn-audio-toggle');
  _popoverEl = document.getElementById('audio-volume-popover');
  _sliderEl = document.getElementById('audio-volume-slider');

  const videoEls = [
    document.getElementById('viewer-video'),
    document.getElementById('viewer-video-b')
  ].filter(Boolean);

  for (const vEl of videoEls) {
    vEl.addEventListener('play', () => _syncAudioWithVideo(vEl));
    vEl.addEventListener('seeked', () => _syncAudioWithVideo(vEl));
  }

  if (_containerEl) {
    _containerEl.addEventListener('wheel', _onWheel, { passive: false });
    _containerEl.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });
    _containerEl.addEventListener('mouseleave', () => {
      if (_containerEl.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    });
  }

  if (_btnToggleEl) {
    _btnToggleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAudioMute();
    });
  }

  if (_sliderEl) {
    _sliderEl.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      setAudioVolume(val);
    });
  }

  if (_audioEl) {
    _audioEl.addEventListener('error', () => {
      _hasAudioTrack = false;
      _updateUI();
    });

    _audioEl.addEventListener('loadedmetadata', () => {
      if (_hasAudioTrack && !_currentMuted) {
        _audioEl.play().catch(() => {});
      }
    });
  }

  _updateUI();

  if (_Core) {
    _Core.onStateChange(_syncAudioState);
  }
}

export const ViewerAudio = {
  toggleAudioMute,
  setAudioVolume,
  stepAudioVolume
};
