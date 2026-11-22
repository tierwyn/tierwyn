/** navigator.clipboard is secure-context-only (HTTPS / localhost); on a plain-HTTP
 *  LAN hub it is undefined. Fall back to the legacy textarea + execCommand path. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand('copy')) throw new Error('copy failed');
  } finally {
    ta.remove();
  }
}
