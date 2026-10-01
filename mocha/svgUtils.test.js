import assert from 'node:assert/strict';
import { expandSvgEntities, prepareSvgForCanvas } from '../src/js/shared/svgUtils.js';

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
});
