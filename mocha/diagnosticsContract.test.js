import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_MAP } from '../src/js/services/actions.js';
import { initReplayDiagnostics } from '../e2e/replay-diagnostics/base.js';
import { initRecorderShim } from '../e2e/helpers/recorder-shim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

describe('Diagnostics system contract integrity', () => {
  describe('Recorded scenarios validity', () => {
    const scenariosDir = path.join(projectRoot, 'e2e', 'scenarios');

    it('ensures all actions in recorded scenarios exist in ACTION_REGISTRY', () => {
      assert.ok(fs.existsSync(scenariosDir), 'e2e/scenarios directory must exist');
      const files = fs.readdirSync(scenariosDir).filter(f => f.endsWith('.json'));
      assert.ok(files.length > 0, 'Must have at least one recorded scenario');

      // Trace steps the replay runner handles itself, next to registry ids.
      const TRACE_STEPS = new Set(['select-index', 'jump-to-index', 'open-favorite']);
      for (const file of files) {
        const filePath = path.join(scenariosDir, file);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        assert.ok(Array.isArray(content.actions), `Scenario ${file} must have actions array`);

        for (let i = 0; i < content.actions.length; i++) {
          const item = content.actions[i];
          const actionId = typeof item === 'string' ? item : item?.action;
          assert.ok(
            actionId && (ACTION_MAP.has(actionId) || TRACE_STEPS.has(actionId)),
            `Scenario ${file} action at index ${i} ('${actionId}') does not exist in ACTION_REGISTRY`
          );
        }
      }
    });
  });

  describe('Viewer pipeline DOM contract with probes', () => {
    const indexHtmlPath = path.join(projectRoot, 'src', 'index.html');
    const viewerRenderPath = path.join(projectRoot, 'src', 'js', 'viewer', 'viewerRender.js');
    const viewerPipelinesPath = path.join(projectRoot, 'src', 'js', 'viewer', 'viewerPipelines.js');
    const manhwaStripPath = path.join(projectRoot, 'src', 'js', 'viewer', 'manhwaStrip.js');

    it('validates critical DOM IDs and classes queried by viewerPipelineProbe', () => {
      assert.ok(fs.existsSync(indexHtmlPath), 'src/index.html must exist');
      assert.ok(fs.existsSync(viewerRenderPath), 'viewerRender.js must exist');
      assert.ok(fs.existsSync(viewerPipelinesPath), 'viewerPipelines.js must exist');
      assert.ok(fs.existsSync(manhwaStripPath), 'manhwaStrip.js must exist');

      const indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');
      const viewerRender = fs.readFileSync(viewerRenderPath, 'utf-8');
      const viewerPipelines = fs.readFileSync(viewerPipelinesPath, 'utf-8');
      const manhwaStrip = fs.readFileSync(manhwaStripPath, 'utf-8');

      // #viewer-img-wrapper, #statusbar, and video pool elements must exist in index.html
      assert.ok(indexHtml.includes('id="viewer-img-wrapper"'), 'index.html must define id="viewer-img-wrapper"');
      assert.ok(indexHtml.includes('id="statusbar"'), 'index.html must define id="statusbar"');
      assert.ok(indexHtml.includes('id="viewer-video"'), 'index.html must define id="viewer-video"');
      assert.ok(indexHtml.includes('id="viewer-video-b"'), 'index.html must define id="viewer-video-b"');

      // #manhwa-strip and spacers must exist in index.html
      assert.ok(indexHtml.includes('id="manhwa-strip"'), 'index.html must define id="manhwa-strip"');
      assert.ok(indexHtml.includes('id="manhwa-strip-spacer-top"'), 'index.html must define id="manhwa-strip-spacer-top"');
      assert.ok(indexHtml.includes('id="manhwa-strip-spacer-bottom"'), 'index.html must define id="manhwa-strip-spacer-bottom"');

      // manhwaStrip must manage strip, spacers, and slot classes
      assert.ok(manhwaStrip.includes('manhwa-strip-spacer-top'), 'manhwaStrip.js must reference manhwa-strip-spacer-top');
      assert.ok(manhwaStrip.includes('manhwa-strip-spacer-bottom'), 'manhwaStrip.js must reference manhwa-strip-spacer-bottom');
      assert.ok(manhwaStrip.includes('manhwa-slot'), 'manhwaStrip.js must reference manhwa-slot class');

      // viewerRender must use viewer-img and viewer-video classes, plus active / bridge pool roles
      assert.ok(viewerRender.includes('viewer-img'), 'viewerRender.js must reference viewer-img class');
      assert.ok(viewerRender.includes('viewer-video'), 'viewerRender.js must reference viewer-video class');
      assert.ok(viewerRender.includes('active'), 'viewerRender.js must manage active pool role');
      assert.ok(viewerRender.includes('bridge'), 'viewerRender.js must manage bridge pool role');

      // #viewer-ico-row and ico-container elements must exist and be managed
      assert.ok(indexHtml.includes('id="viewer-ico-row"'), 'index.html must define id="viewer-ico-row"');
      assert.ok(viewerRender.includes('viewer-ico-row'), 'viewerRender.js must reference viewer-ico-row');
      assert.ok(viewerRender.includes('ico-container'), 'viewerRender.js must reference ico-container');
      assert.ok(manhwaStrip.includes('ico-container'), 'manhwaStrip.js must reference ico-container');

      // viewerPipelines must manage canvas elements and render-ready data attributes
      assert.ok(viewerPipelines.includes('viewer-lanczos-canvas'), 'viewerPipelines.js must reference viewer-lanczos-canvas');
      assert.ok(viewerPipelines.includes('viewer-filter-canvas'), 'viewerPipelines.js must reference viewer-filter-canvas');
      assert.ok(viewerPipelines.includes('manhwa-filter-canvas'), 'viewerPipelines.js must reference manhwa-filter-canvas');
      assert.ok(indexHtml.includes('id="manhwa-filter-canvas"'), 'index.html must define id="manhwa-filter-canvas"');
      assert.ok(indexHtml.includes('id="manhwa-svg-pump-layer"'), 'index.html must define id="manhwa-svg-pump-layer"');
      assert.ok(indexHtml.includes('id="manhwa-audio-overlay"'), 'index.html must define id="manhwa-audio-overlay"');
      assert.ok(viewerPipelines.includes('data-render-ready'), 'viewerPipelines.js must track data-render-ready');
      assert.ok(viewerPipelines.includes('data-filter'), 'viewerPipelines.js must track data-filter for column composite');

      // manhwaStrip must manage strip scaling and slot dataset attributes
      assert.ok(manhwaStrip.includes('dataset.scaling'), 'manhwaStrip.js must manage dataset.scaling');
      assert.ok(manhwaStrip.includes('dataset.ready'), 'manhwaStrip.js must manage dataset.ready');
      assert.ok(manhwaStrip.includes('dataset.imgIdx'), 'manhwaStrip.js must manage dataset.imgIdx');
    });
  });

  describe('Diagnostic engine exports and functions', () => {
    it('exports initReplayDiagnostics in base engine', () => {
      assert.equal(typeof initReplayDiagnostics, 'function');
    });

    it('exports initRecorderShim in recorder helper', () => {
      assert.equal(typeof initRecorderShim, 'function');
    });

    it('validates investigation.js export contract if present', async () => {
      const investigationPath = path.join(projectRoot, 'e2e', 'replay-diagnostics', 'investigation.js');
      if (fs.existsSync(investigationPath)) {
        const investigationModule = await import('../e2e/replay-diagnostics/investigation.js');
        assert.equal(
          typeof investigationModule.initReplayDiagnostics,
          'function',
          'investigation.js must export initReplayDiagnostics'
        );
      }
    });
  });
});
