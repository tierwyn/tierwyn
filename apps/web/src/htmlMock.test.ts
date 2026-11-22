import { describe, it, expect } from 'vitest';
import { CAPTURE_MSG, buildMockSrcDoc, captureBootstrap, capturePixelRatio } from './htmlMock.js';

function injectedAfter(html: string, src: string): string {
  const idx = src.indexOf(html);
  return idx >= 0 ? src.slice(idx + html.length) : '';
}

describe('buildMockSrcDoc', () => {
  it('contains the CSP meta, original HTML, bootstrap, and CAPTURE_MSG', () => {
    const html = '<!doctype html><html><body><h1>hello</h1></body></html>';
    const src = buildMockSrcDoc(html, '/* lib */');
    expect(src.startsWith('<meta http-equiv="Content-Security-Policy" content="')).toBe(true);
    expect(src).toContain("default-src 'none'");
    expect(src).toContain("frame-src 'none'");
    expect(src).toContain("script-src 'unsafe-inline'");
    expect(src).toContain("style-src 'unsafe-inline'");
    expect(src).toContain("connect-src 'none'");
    expect(src).toContain(html);
    expect(src).toContain(CAPTURE_MSG);
    expect(src).toContain("addEventListener('message'");
    expect(src).toContain('htmlToImage.toPng');
  });

  it('escapes </script> in the library source so the script tag does not close early', () => {
    const html = '<html></html>';
    const lib = 'var x = "</script>";';
    const src = buildMockSrcDoc(html, lib);
    expect(src).toContain('<\\/script>');
    expect(src).not.toContain(lib);
    const afterHtml = injectedAfter(html, src);
    const scriptOpen = afterHtml.indexOf('<script>');
    expect(scriptOpen).toBeGreaterThanOrEqual(0);
    expect(afterHtml.slice(scriptOpen).match(/<\/script>/g)?.length).toBe(1);
  });

  it('does not absorb the bootstrap when html ends inside an unclosed comment', () => {
    const html = '<html><body><!-- unfinished';
    const src = buildMockSrcDoc(html, '/* lib */');
    const injected = injectedAfter(html, src);
    const commentClose = injected.indexOf('-->');
    const scriptOpen = injected.indexOf('<script>');
    expect(commentClose).toBeGreaterThanOrEqual(0);
    expect(scriptOpen).toBeGreaterThan(commentClose);
    expect(injected).toContain("addEventListener('message'");
  });

  it('does not absorb the bootstrap when html ends inside an unclosed textarea', () => {
    const html = '<html><body><textarea>unfinished';
    const src = buildMockSrcDoc(html, '/* lib */');
    const injected = injectedAfter(html, src);
    const textareaClose = injected.indexOf('</textarea>');
    const scriptOpen = injected.indexOf('<script>');
    expect(textareaClose).toBeGreaterThanOrEqual(0);
    expect(scriptOpen).toBeGreaterThan(textareaClose);
    expect(injected).toContain("addEventListener('message'");
  });
});

describe('captureBootstrap', () => {
  it('injects capturePixelRatio so the iframe uses the tested helper', () => {
    const src = captureBootstrap('/* lib */');
    expect(src).toContain(`const capturePixelRatio = ${capturePixelRatio.toString()};`);
    expect(src).toContain('capturePixelRatio(e.data.dpr, w, h)');
    expect(src).not.toContain('pixelRatio: Math.min(e.data.dpr');
  });

  it('injects in-page anchor navigation click listener', () => {
    const src = captureBootstrap('/* lib */');
    expect(src).toContain("document.addEventListener('click'");
    expect(src).toContain("href.startsWith('#')");
    expect(src).toContain("location.hash = href;");
    expect(src).toContain("e.preventDefault()");
  });

  it('injects descriptive error formatting fallback for DOM-to-image capture failure', () => {
    const src = captureBootstrap('/* lib */');
    expect(src).toContain('Failed to render DOM to image (check for malformed HTML/XML or unrenderable resources)');
    expect(src).toContain("err.type === 'error'");
  });
});

describe('capturePixelRatio', () => {
  it('caps device pixel ratio at 2', () => {
    expect(capturePixelRatio(3, 1000, 1000)).toBe(2);
  });

  it('clamps so neither canvas side exceeds 16384', () => {
    expect(capturePixelRatio(2, 1000, 20000)).toBe(16384 / 20000);
  });
});
