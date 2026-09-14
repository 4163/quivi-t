import fs from 'fs';
import path from 'path';
import os from 'os';
import { expect } from 'expect-webdriverio';
import menubarPage from '../pageobjects/menubar.page.js';
import filepanelPage from '../pageobjects/filepanel.page.js';
import { fixtures } from '../helpers/fixtures.js';

describe('07 - OS Integration & Shell Origin Resolution', () => {
  before(async () => {
    await menubarPage.ensureMainWindow();
  });

  it('queries supported format status list via Tauri IPC', async () => {
    const statuses = await menubarPage.invokeTauri('get_format_status');
    expect(Array.isArray(statuses)).toBe(true);
    expect(statuses.length).toBeGreaterThan(5);

    const exts = statuses.map((s) => s.ext.toLowerCase());
    expect(exts).toContain('png');
    expect(exts).toContain('jpg');
    expect(exts).toContain('cbz');
    expect(exts).toContain('zip');
  });

  it('retrieves default pictures directory and process launch arguments', async () => {
    const defaultDir = await menubarPage.invokeTauri('get_default_dir');
    expect(typeof defaultDir).toBe('string');
    expect(defaultDir.length).toBeGreaterThan(0);

    const initialArgs = await menubarPage.invokeTauri('get_initial_args');
    expect(Array.isArray(initialArgs)).toBe(true);
    expect(initialArgs.length).toBeGreaterThan(0);
  });

  it('gracefully returns null for standard non-temporary paths in temp origin resolution', async () => {
    const normalOrigin = await menubarPage.invokeTauri('resolve_archive_temp_origin', {
      path: fixtures.testPng,
    });
    expect(normalOrigin).toBeNull();

    const invalidOrigin = await menubarPage.invokeTauri('resolve_archive_temp_origin', {
      path: 'C:\\non_existent_path\\image.png',
    });
    expect(invalidOrigin).toBeNull();
  });

  it('resolves candidate archive origin and opens parent archive from Windows Explorer temp extraction', async () => {
    const downloadsDir = path.join(process.env.USERPROFILE || '', 'Downloads');
    if (!fs.existsSync(downloadsDir)) {
      // If Downloads directory does not exist, skip candidate resolution gracefully
      return;
    }

    const candidateZip = path.join(downloadsDir, 'zip.zip');
    const tempDir = path.join(os.tmpdir(), '8c8b0bbf-a0e0-48b1-bd41-8a199b9c66e5_zip.zip.6e5');
    const tempExtractedFile = path.join(tempDir, 'export_1785518835803.apng');

    try {
      // 1. Place a candidate archive in the user's Downloads folder
      fs.copyFileSync(fixtures.zip, candidateZip);

      // 2. Simulate Windows Explorer temp extraction folder structure
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(tempExtractedFile, '');

      // 3. Test direct IPC resolution
      const origin = await menubarPage.invokeTauri('resolve_archive_temp_origin', {
        path: tempExtractedFile,
      });
      expect(origin).toBeDefined();
      expect(origin.archive_path.toLowerCase()).toContain('zip.zip');
      expect(origin.entry_name).toBe('export_1785518835803.apng');

      // 4. Test live application integration: opening the temp file resolves to parent archive
      await browser.execute((filePath) => {
        if (window.__TAURI__ && window.__TAURI__.event) {
          window.__TAURI__.event.emit('single-instance-open', filePath);
        }
      }, tempExtractedFile);

      // Breadcrumb should show the resolved parent archive name
      await browser.waitUntil(
        async () => {
          const text = await filepanelPage.breadcrumb.getText();
          return text.toLowerCase().includes('zip.zip');
        },
        { timeout: 10000, timeoutMsg: 'Parent archive zip.zip failed to open from temp extraction' }
      );

      // File list should render entries from the parent archive
      const count = await filepanelPage.getItemCount();
      expect(count).toBeGreaterThan(0);
    } finally {
      // Clean up temporary test artifacts
      try { if (fs.existsSync(tempExtractedFile)) fs.unlinkSync(tempExtractedFile); } catch {}
      try { if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir); } catch {}
      try { if (fs.existsSync(candidateZip)) fs.unlinkSync(candidateZip); } catch {}
    }
  });
});
