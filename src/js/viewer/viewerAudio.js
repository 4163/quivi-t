/**
 * viewerAudio.js: Headless audio playback and UI controls for video items.
 */

let _Core = null;
let _FsUtils = null;

let _containerEl = null;
let _audioEl = null;
let _btnToggleEl = null;
let _popoverEl = null;
let _sliderEl = null;

let _sessionMuted = true;
let _sessionVolume = 0.5;
let _activeAudioPath = null;
let _hasAudioTrack = false;

function _updateUI() {
  if (!_btnToggleEl || !_popoverEl || !_sliderEl) return;

  if (!_hasAudioTrack) {
    _btnToggleEl.disabled = true;
    _btnToggleEl.tabIndex = -1;
    _btnToggleEl.title = 'No Audio';
    _btnToggleEl.setAttribute('aria-label', 'No Audio');
    _popoverEl.classList.add('is-disabled');
    _btnToggleEl.removeAttribute('data-state');
    return;
  }

  _btnToggleEl.disabled = false;
  _btnToggleEl.tabIndex = 0;
  _btnToggleEl.title = _sessionMuted ? 'Unmute Audio (M)' : 'Mute Audio (M)';
  _btnToggleEl.setAttribute('aria-label', _sessionMuted ? 'Unmute Audio' : 'Mute Audio');
  _popoverEl.classList.remove('is-disabled');

  if (_sessionMuted) {
    _btnToggleEl.setAttribute('data-state', 'muted');
  } else if (_sessionVolume <= 0) {
    _btnToggleEl.setAttribute('data-state', 'zero');
  } else if (_sessionVolume < 0.5) {
    _btnToggleEl.setAttribute('data-state', 'low');
  } else {
    _btnToggleEl.setAttribute('data-state', 'high');
  }

  _sliderEl.value = _sessionVolume;
}

function _applyAudioState() {
  if (!_audioEl) return;
  _audioEl.volume = _sessionVolume;
  _audioEl.muted = _sessionMuted;

  if (_hasAudioTrack && !_sessionMuted) {
    _audioEl.play().catch(() => {});
  } else {
    _audioEl.pause();
  }
}

function _resetAudio() {
  _activeAudioPath = null;
  _hasAudioTrack = false;
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
  if (!_hasAudioTrack) return;
  _sessionMuted = !_sessionMuted;
  if (!_sessionMuted && _sessionVolume <= 0) {
    _sessionVolume = 0.5;
  }
  _applyAudioState();
  _updateUI();
}

export function setAudioVolume(volume, { unmute = true } = {}) {
  _sessionVolume = Math.max(0, Math.min(1, volume));
  if (unmute && _sessionVolume > 0 && _sessionMuted) {
    _sessionMuted = false;
  }
  _applyAudioState();
  _updateUI();
}

export function stepAudioVolume(delta) {
  const next = Math.round((_sessionVolume + delta) * 100) / 100;
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

  // Immediately default to no audio (disabled with Lucide volume-off) while verifying
  _hasAudioTrack = false;
  _updateUI();

  if (_audioEl) {
    _audioEl.pause();
    _audioEl.removeAttribute('src');
  }

  let hasAudio = false;
  if (item.hasSound !== undefined) {
    hasAudio = Boolean(item.hasSound);
  } else if (_FsUtils?.checkMediaAudio) {
    hasAudio = await _FsUtils.checkMediaAudio(filePath, state.archivePath || null);
    item.hasSound = hasAudio;
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
      if (_hasAudioTrack && !_sessionMuted) {
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
