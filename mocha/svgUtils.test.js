import assert from 'node:assert/strict';
import { expandSvgEntities, prepareSvgForCanvas, resolveSvgDimensions } from '../src/js/shared/svgUtils.js';

describe('svgUtils', () => {
  describe('expandSvgEntities', () => {
    it('expands entities and strips doctype', () => {
      const svg = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY color "#ff0000">]><svg><rect fill="&color;"/></svg>';
      const res = expandSvgEntities(svg);
      assert.equal(res, '<svg><rect fill="#ff0000"/></svg>');
    });

    it('returns non-string or entity-free input untouched', () => {
      assert.equal(expandSvgEntities(null), null);
      assert.equal(expandSvgEntities('<svg><rect/></svg>'), '<svg><rect/></svg>');
    });
  });

  describe('prepareSvgForCanvas', () => {
    it('returns empty string for non-string input', () => {
      assert.equal(prepareSvgForCanvas(null), '');
      assert.equal(prepareSvgForCanvas(undefined), '');
    });

    it('strips foreignObject blocks to prevent canvas tainting', () => {
      const svg = '<svg><switch><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">test</div></foreignObject><g><rect/></g></switch></svg>';
      const res = prepareSvgForCanvas(svg);
      assert.ok(!res.includes('foreignObject'));
      assert.ok(res.includes('<switch><g><rect/></g></switch>'));
    });

    it('strips Illustrator i:pgf private binary data payload', () => {
      const svg = '<svg><g><rect/></g><i:pgf id="adobe_illustrator_pgf"><![CDATA[binarydata]]></i:pgf></svg>';
      const res = prepareSvgForCanvas(svg);
      assert.ok(!res.includes('i:pgf'));
      assert.ok(res.includes('<svg><g><rect/></g></svg>'));
    });

    it('combines entity expansion with foreignObject and pgf stripping', () => {
      const svg = `<!DOCTYPE svg [
        <!ENTITY st0 "fill:#46CC37;">
        <!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">
      ]>
      <svg>
        <switch>
          <foreignObject requiredExtensions="&ns_ai;" width="1" height="1">
            <i:pgfRef xlink:href="#pgf"/>
          </foreignObject>
          <g><path style="&st0;"/></g>
        </switch>
        <i:pgf id="pgf">rawdata</i:pgf>
      </svg>`;
      const res = prepareSvgForCanvas(svg);
      assert.ok(!res.includes('<!DOCTYPE'));
      assert.ok(!res.includes('foreignObject'));
      assert.ok(!res.includes('i:pgf'));
      assert.ok(res.includes('style="fill:#46CC37;"'));
    });
  });

  describe('resolveSvgDimensions', () => {
    it('preserves valid natural dimensions when not default or exceeding maxEdge', () => {
      const res = resolveSvgDimensions(640, 480, '<svg></svg>', 1080);
      assert.deepEqual(res, { width: 640, height: 480 });
    });

    it('parses viewBox when natural dimensions match browser defaults', () => {
      const svg = '<svg viewBox="0 0 1920 1080"></svg>';
      const res150 = resolveSvgDimensions(150, 150, svg, 2048);
      assert.deepEqual(res150, { width: 1920, height: 1080 });
      const res300 = resolveSvgDimensions(300, 150, svg, 2048);
      assert.deepEqual(res300, { width: 1920, height: 1080 });
    });

    it('falls back to 1000x1000 when no viewBox is present for missing dimensions', () => {
      const res = resolveSvgDimensions(0, 0, '<svg></svg>', 2048);
      assert.deepEqual(res, { width: 1000, height: 1000 });
    });

    it('scales dimensions proportionally when exceeding maxEdge', () => {
      const res = resolveSvgDimensions(2000, 1000, '<svg></svg>', 1000);
      assert.deepEqual(res, { width: 1000, height: 500 });
    });
  });
});
