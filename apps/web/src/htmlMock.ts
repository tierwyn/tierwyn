export const CAPTURE_MSG = 'tierwyn:html-capture';

/** Clamp pixel ratio so the canvas stays inside browser limits. */
export function capturePixelRatio(dpr: number, w: number, h: number): number {
  return Math.min(dpr || 1, 2, 16384 / w, 16384 / h);
}

/** Script appended to the mock's srcDoc. Runs inside the opaque-origin iframe. */
export function captureBootstrap(libSrc: string): string {
  const lib = libSrc.replace(/<\/script/gi, '<\\/script');
  return `<script>${lib}
document.addEventListener('click', (e) => {
  const t = e.target;
  const el = t && (t.nodeType === 1 ? t : t.parentElement);
  const a = el && el.closest ? el.closest('a[href]') : null;
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href || /^javascript:/i.test(href)) return;
  e.preventDefault();
  if (href.startsWith('#')) location.hash = href;
}, true);
const capturePixelRatio = ${capturePixelRatio.toString()};
addEventListener('message', async (e) => {
  if (e.source !== parent || !e.data || e.data.type !== 'tierwyn:html-capture') return;
  const id = e.data.id, d = document.documentElement;
  try {
    if (document.fonts) await document.fonts.ready;
    const w = d.scrollWidth, h = d.scrollHeight;
    const bg = getComputedStyle(document.body || d).backgroundColor;
    const dataUrl = await htmlToImage.toPng(d, {
      width: w, height: h,
      pixelRatio: capturePixelRatio(e.data.dpr, w, h),
      backgroundColor: (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') ? '#ffffff' : bg,
      imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
      cacheBust: false,
    });
    parent.postMessage({ type: 'tierwyn:html-capture', id, dataUrl }, '*');
  } catch (err) {
    const errMsg = err instanceof Error
      ? err.message
      : (typeof err === 'object' && err !== null && (err.type === 'error' || (typeof Event !== 'undefined' && err instanceof Event))
          ? 'Failed to render DOM to image (check for malformed HTML/XML or unrenderable resources)'
          : String(err && err.message || err));
    parent.postMessage({ type: 'tierwyn:html-capture', id, error: errMsg }, '*');
  }
});
</script>`;
}

/** srcDoc = mock HTML + library + bootstrap. Appending after </html> is fine: the parser moves it into <body>. */
export function buildMockSrcDoc(html: string, libSrc: string): string {
  // Injected at the start so the browser parses it into <head> before scripts execute.
  const CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  // Defend against unclosed comments or raw-text tags in agent mocks
  const reset = '--> </script> </style> </textarea> </title>';
  return cspMeta + '\n' + html + '\n' + reset + '\n' + captureBootstrap(libSrc);
}
