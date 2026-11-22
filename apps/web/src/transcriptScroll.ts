/** True when the transcript viewport is already (nearly) at the bottom. */
export function isPinnedToBottom(opts: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  slack?: number;
}): boolean {
  const slack = opts.slack ?? 80;
  return opts.scrollHeight - opts.scrollTop - opts.clientHeight <= slack;
}

/**
 * Whether a content-size change should yank the transcript to the bottom.
 * Height must have grown (image decode, streamed markdown) — shrinks and
 * scrollbar-width reflows must not pin, or the pane oscillates.
 */
export function shouldPinOnContentResize(opts: {
  now: number;
  stickyUntil: number;
  autoScroll: boolean;
  agentStatus: string;
  heightGrew: boolean;
  prependGuard?: boolean;
}): boolean {
  if (opts.prependGuard) return false;
  if (!opts.heightGrew) return false;
  if (opts.now < opts.stickyUntil) return true;
  if (!opts.autoScroll) return false;
  return opts.agentStatus === 'running' || opts.agentStatus === 'waiting';
}
