import { Core } from '../core.js';
import * as Chrome from '../menubar/chrome.js';
import { normalizeCombo, formatKeyName, normalizeList } from '../services/keyCombo.js';

let fullscreenActive = false;
const FULLSCREEN_EXIT_HINT_MS = 4000;
const FULLSCREEN_EXIT_KEY_HOLD_MS = 1500;
const FULLSCREEN_EXIT_HOLD_FEEDBACK_MS = FULLSCREEN_EXIT_KEY_HOLD_MS / 2;
const FULLSCREEN_EXIT_TRIGGER_Y = 5;
let fullscreenExitHideY = 50;
let fullscreenExitHintTimer = null;
let fullscreenExitKeyHoldTimer = null;
let fullscreenExitHoldFeedbackTimer = null;
let fullscreenExitHoldFeedbackVisible = false;
let fullscreenExitHoverVisible = false;
let fullscreenExitHideProbe = null;

const fullscreenExitHint = document.getElementById('fullscreen-exit-hint');
const fullscreenExitKey = document.getElementById('fullscreen-exit-key');
const fullscreenExitRegion = document.getElementById('fullscreen-exit-region');
const fullscreenExitBtn = document.getElementById('fullscreen-exit-btn');

function getFullscreenExitBindings() {
  const bind = Core.getState().config?.frontend_data?.keybinds?.['cmd-exit-fullscreen-hold'];
  const list = normalizeList(bind).filter(Boolean);
  return list.length > 0 ? list : ['Escape'];
}

function formatFullscreenExitKeyLabel() {
  const bindings = getFullscreenExitBindings();
  const combo = bindings.find(b => normalizeCombo(b) !== 'Escape') || bindings[0] || 'Unbound';
  return normalizeCombo(combo).replaceAll('Escape', 'Esc');
}

export function syncKeyLabel() {
  if (fullscreenExitKey) fullscreenExitKey.textContent = formatFullscreenExitKeyLabel();
}

function initFullscreenExitHideProbe() {
  if (fullscreenExitHideProbe) return;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:-9999px;width:var(--fs-50);height:1px;visibility:hidden;';
  document.body.appendChild(probe);
  fullscreenExitHideProbe = probe;

  const sync = () => {
    fullscreenExitHideY = probe.getBoundingClientRect().width;
  };
  sync();
  new ResizeObserver(sync).observe(probe);
}

function keyEventCombo(e) {
  const keys = [];
  if (e.ctrlKey) keys.push('Ctrl');
  if (e.altKey) keys.push('Alt');
  if (e.shiftKey) keys.push('Shift');
  const keyName = formatKeyName(e.key);
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(keyName)) keys.push(keyName);
  return keys.join('+');
}

function isFullscreenExitKey(e) {
  const combo = keyEventCombo(e).toLowerCase();
  return getFullscreenExitBindings().some(bind => normalizeCombo(bind).toLowerCase() === combo);
}

function cancelFullscreenExitKeyHold({ hideFeedback = false } = {}) {
  clearTimeout(fullscreenExitKeyHoldTimer);
  clearTimeout(fullscreenExitHoldFeedbackTimer);
  fullscreenExitKeyHoldTimer = null;
  fullscreenExitHoldFeedbackTimer = null;
  if (hideFeedback && fullscreenExitHoldFeedbackVisible) hideFullscreenExitHint();
  fullscreenExitHoldFeedbackVisible = false;
}

function hideFullscreenExitHint() {
  clearTimeout(fullscreenExitHintTimer);
  fullscreenExitHintTimer = null;
  fullscreenExitHint?.classList.remove('visible');
}

function showFullscreenExitHint({ autoHide = true } = {}) {
  syncKeyLabel();
  clearTimeout(fullscreenExitHintTimer);
  fullscreenExitHint?.classList.add('visible');
  fullscreenExitHintTimer = autoHide ? setTimeout(hideFullscreenExitHint, FULLSCREEN_EXIT_HINT_MS) : null;
}

function showFullscreenExitButton() {
  if (!fullscreenActive || fullscreenExitHoverVisible) return;
  hideFullscreenExitHint();
  fullscreenExitHoverVisible = true;
  document.body.classList.add('fullscreen-exit-visible');
}

function hideFullscreenExitButton() {
  if (!fullscreenExitHoverVisible) return;
  fullscreenExitHoverVisible = false;
  document.body.classList.remove('fullscreen-exit-visible');
}

function setFullscreenUiActive(active) {
  fullscreenActive = active;
  document.body.classList.toggle('fullscreen-active', active);
  fullscreenExitRegion?.setAttribute('aria-hidden', active ? 'false' : 'true');
  if (fullscreenExitBtn) {
    fullscreenExitBtn.toggleAttribute('disabled', !active);
    fullscreenExitBtn.tabIndex = active ? 0 : -1;
  }
  cancelFullscreenExitKeyHold();
  hideFullscreenExitButton();
  if (active) {
    showFullscreenExitHint();
  } else {
    hideFullscreenExitHint();
  }
  document.getElementById('cmd-fullscreen')?.classList.toggle('checked', active);
}

function startFullscreenExitKeyHold(e) {
  if (!fullscreenActive || fullscreenExitKeyHoldTimer !== null || !isFullscreenExitKey(e)) return false;
  fullscreenExitHoldFeedbackVisible = false;
  fullscreenExitHoldFeedbackTimer = setTimeout(() => {
    if (fullscreenActive && fullscreenExitKeyHoldTimer !== null) {
      fullscreenExitHoldFeedbackVisible = true;
      showFullscreenExitHint({ autoHide: false });
    }
  }, FULLSCREEN_EXIT_HOLD_FEEDBACK_MS);
  fullscreenExitKeyHoldTimer = setTimeout(() => {
    cancelFullscreenExitKeyHold();
    if (fullscreenActive) toggleFullscreen();
  }, FULLSCREEN_EXIT_KEY_HOLD_MS);
  return true;
}

function handleFullscreenExitKeyDown(e) {
  if (!fullscreenActive || !isFullscreenExitKey(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat) startFullscreenExitKeyHold(e);
}

function handleFullscreenExitKeyUp(e) {
  if (!fullscreenActive || fullscreenExitKeyHoldTimer === null) return;
  e.preventDefault();
  e.stopPropagation();
  cancelFullscreenExitKeyHold({ hideFeedback: true });
}

function handleFullscreenExitMouseMove(e) {
  if (!fullscreenActive) return;
  const y = e.clientY;

  if (!fullscreenExitHoverVisible) {
    if (y <= FULLSCREEN_EXIT_TRIGGER_Y) showFullscreenExitButton();
    return;
  }

  if (y > fullscreenExitHideY) hideFullscreenExitButton();
}

export async function toggleFullscreen() {
  const enteringFullscreen = window.__TAURI__
    ? !(await window.__TAURI__.window.getCurrentWindow().isFullscreen())
    : !document.fullscreenElement;

  const config = Core.getState()?.config;
  const hideChrome = config?.frontend_data?.hide_chrome_on_fullscreen !== false;

  if (enteringFullscreen) {
    Chrome.snapshotPreFullscreenChrome();
    if (hideChrome) Chrome.setFullscreenChromeVisible(false);
  }

  setFullscreenUiActive(enteringFullscreen);

  if (window.__TAURI__) {
    const win = window.__TAURI__.window.getCurrentWindow();
    await win.setFullscreen(enteringFullscreen);
  } else if (enteringFullscreen) {
    await document.documentElement.requestFullscreen();
  } else {
    await document.exitFullscreen();
  }

  if (!enteringFullscreen) requestAnimationFrame(Chrome.restorePreFullscreenChrome);
}

export function syncFullscreenState(isFullscreen) {
  if (isFullscreen && !fullscreenActive) {
    Chrome.snapshotPreFullscreenChrome();
    setFullscreenUiActive(true);
    const config = Core.getState()?.config;
    const hideChrome = config?.frontend_data?.hide_chrome_on_fullscreen !== false;
    if (hideChrome) Chrome.setFullscreenChromeVisible(false);
  }
}

export function isFullscreenActive() {
  return fullscreenActive;
}

export function initFullscreen() {
  initFullscreenExitHideProbe();

  document.addEventListener('fullscreenchange', () => {
    if (!window.__TAURI__) setFullscreenUiActive(!!document.fullscreenElement);
  });

  window.addEventListener('pointermove', handleFullscreenExitMouseMove, { passive: true });
  window.addEventListener('keydown', handleFullscreenExitKeyDown, { capture: true });
  window.addEventListener('keyup', handleFullscreenExitKeyUp, { capture: true });
  window.addEventListener('blur', () => cancelFullscreenExitKeyHold({ hideFeedback: true }));

  if (fullscreenExitBtn) {
    fullscreenExitBtn.addEventListener('click', (e) => {
      if (!fullscreenActive) return;
      e.preventDefault();
      hideFullscreenExitButton();
      toggleFullscreen();
    });
    fullscreenExitBtn.addEventListener('keydown', (e) => {
      if (!fullscreenActive || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      hideFullscreenExitButton();
      toggleFullscreen();
    });
  }
}
