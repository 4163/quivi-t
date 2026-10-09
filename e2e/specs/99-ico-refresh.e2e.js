import viewerPage from '../pageobjects/viewer.page.js';
import statusbarPage from '../pageobjects/statusbar.page.js';
import { fixtures } from '../helpers/fixtures.js';

async function dump(tag) {
  const data = await browser.execute(async () => {
    const { Core } = await import('/js/core.js');
    const { FsUtils } = await import('/js/fsUtils.js');
    const state = Core.getState();
    const row = document.getElementById('viewer-ico-row');
    const wrapper = document.getElementById('viewer-img-wrapper');
    const cells = Array.from(row?.querySelectorAll('.ico-size') || []).map((c) => ({
      w: c.style.getPropertyValue('--ico-w'),
      h: c.style.getPropertyValue('--ico-h'),
      ready: c.dataset.ready || null,
      imgW: c.querySelector('img')?.naturalWidth || 0,
      imgH: c.querySelector('img')?.naturalHeight || 0,
    }));
    return {
      srcIsArray: Array.isArray(state.src),
      srcLen: Array.isArray(state.src) ? state.src.length : (typeof state.src === 'string' ? state.src.slice(0, 60) : state.src),
      srcSizes: Array.isArray(state.src) ? state.src.map((s) => `${s.width}x${s.height}`) : null,
      total: FsUtils.icoSourcesTotal(state.src),
      naturalWidth: state.naturalWidth,
      naturalHeight: state.naturalHeight,
      statusDims: document.querySelector('#statusbar .status-dims')?.textContent || null,
      wrapperDataIco: wrapper?.dataset?.ico || null,
      icoTotalW: wrapper?.style?.getPropertyValue('--ico-total-w') || null,
      icoTotalH: wrapper?.style?.getPropertyValue('--ico-total-h') || null,
      wrapperClientW: wrapper?.clientWidth || 0,
      wrapperClientH: wrapper?.clientHeight || 0,
      rowClientW: row?.clientWidth || 0,
      rowScrollW: row?.scrollWidth || 0,
      cells,
      fitMode: state.fitMode,
      index: state.index,
      listLen: state.list?.length || 0,
    };
  });
  console.log(`ICO_DIAG_${tag} ${JSON.stringify(data)}`);
}

describe('99 - ICO refresh repro (temporary)', () => {
  it('lands on ICO, refreshes, and dumps row dims state', async () => {
    await browser.waitUntil(
      async () => {
        try {
          return await viewerPage.viewport.isDisplayed();
        } catch { return false; }
      },
      { timeout: 15000, timeoutMsg: 'Main window not ready' }
    );

    // Persist remember_last_image so refresh restores the ICO.
    await browser.execute(async () => {
      const { Core } = await import('/js/core.js');
      Core.getState().config.frontend_data.remember_last_image = true;
      await Core.persistConfig({ immediate: true });
    });

    await browser.execute((filePath) => {
      window.__TAURI__.event.emit('single-instance-open', filePath);
    }, fixtures.testIco);

    await browser.waitUntil(
      async () => (await statusbarPage.getFilenameText()).includes('endfield.ico'),
      { timeout: 8000, timeoutMsg: 'ICO file failed to load into statusbar' }
    );
    await browser.waitUntil(
      async () => { try { return await viewerPage.icoRow.isDisplayed(); } catch { return false; } },
      { timeout: 8000, timeoutMsg: 'Legacy ICO row did not display' }
    );
    await dump('WARM');

    // Point last_active_image at the ICO entry, then hard-refresh.
    await browser.execute(async () => {
      const { Core } = await import('/js/core.js');
      const state = Core.getState();
      const entry = (state.list || []).find((e) => (e.name || '').toLowerCase() === 'endfield.ico');
      Core.getState().config.frontend_data.last_active_image = {
        container: state.directory,
        path: entry ? entry.path : null,
      };
      await Core.persistConfig({ immediate: true });
    });

    await browser.refresh();

    await browser.waitUntil(
      async () => {
        try {
          return (await statusbarPage.getFilenameText()).includes('endfield.ico');
        } catch { return false; }
      },
      { timeout: 15000, timeoutMsg: 'ICO file did not restore after refresh' }
    );
    await browser.waitUntil(
      async () => { try { return await viewerPage.icoRow.isDisplayed(); } catch { return false; } },
      { timeout: 15000, timeoutMsg: 'Legacy ICO row did not display after refresh' }
    );
    await dump('POST_REFRESH');
  });
});
