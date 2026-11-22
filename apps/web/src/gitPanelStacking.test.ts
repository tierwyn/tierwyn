import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileModalOverlayClass } from './components/FileModal.js';

// Regression: FileModal must stack above any host Modal. Modal portals with
// modal-overlay--top (z-index 1200); without that class on the file overlay
// (z-index 1000) the file modal rendered invisibly behind the host.
describe('git panel file modal stacking', () => {
  it('fileModalOverlayClass includes modal-overlay--top by default', () => {
    expect(fileModalOverlayClass()).toContain('modal-overlay--top');
    expect(fileModalOverlayClass()).toBe('modal-overlay file-modal-overlay modal-overlay--top');
    // Extra classes still append; default top stacking remains.
    expect(fileModalOverlayClass('custom-extra')).toBe(
      'modal-overlay file-modal-overlay modal-overlay--top custom-extra',
    );
  });

  it('FileModal applies overlayClassName to its portal overlay', () => {
    const src = readFileSync(new URL('./components/FileModal.tsx', import.meta.url), 'utf8');
    expect(src).toContain('fileModalOverlayClass(overlayClassName)');
  });

  it('FileModal sub-modals (Edit, Discard, SpeakChoice) stack above modal-overlay--top (z-index 1300)', () => {
    const editSrc = readFileSync(new URL('./components/EditConfirmModal.tsx', import.meta.url), 'utf8');
    const discardSrc = readFileSync(new URL('./components/DiscardConfirmModal.tsx', import.meta.url), 'utf8');
    const speakChoiceSrc = readFileSync(new URL('./components/SpeakChoiceModal.tsx', import.meta.url), 'utf8');
    const speakScopeSrc = readFileSync(new URL('./components/SpeakScopeModal.tsx', import.meta.url), 'utf8');

    expect(editSrc).toMatch(/zIndex:\s*1300/);
    expect(discardSrc).toMatch(/zIndex:\s*1300/);
    expect(speakChoiceSrc).toMatch(/zIndex:\s*1300/);
    expect(speakScopeSrc).toMatch(/zIndex:\s*1300/);
  });

  it('FileModal sub-modals support fullscreen container portalling (stay above fullscreen modal)', () => {
    const editSrc = readFileSync(new URL('./components/EditConfirmModal.tsx', import.meta.url), 'utf8');
    const discardSrc = readFileSync(new URL('./components/DiscardConfirmModal.tsx', import.meta.url), 'utf8');
    const speakChoiceSrc = readFileSync(new URL('./components/SpeakChoiceModal.tsx', import.meta.url), 'utf8');
    const fileModalSrc = readFileSync(new URL('./components/FileModal.tsx', import.meta.url), 'utf8');

    // Sub-modals accept container and fall back to document.fullscreenElement
    expect(editSrc).toContain('container ??');
    expect(editSrc).toContain('document.fullscreenElement');
    expect(discardSrc).toContain('container ??');
    expect(discardSrc).toContain('document.fullscreenElement');
    expect(speakChoiceSrc).toContain('container ??');
    expect(speakChoiceSrc).toContain('document.fullscreenElement');

    // FileModal passes container when fullscreen
    expect(fileModalSrc).toContain('container={fullscreen ? modalRef.current : undefined}');
  });

  it('GitWorkingTreeModal Escape onClose is guarded by open sub-modals', () => {
    const src = readFileSync(new URL('./components/GitWorkingTreeModal.tsx', import.meta.url), 'utf8');
    expect(src).toContain('if (canCloseHost) onClose()');
  });

  it('index.css defines stacked overlay z-index classes', () => {
    const css = readFileSync(new URL('./styles/index.css', import.meta.url), 'utf8');
    expect(css).toContain('.modal-overlay--stack-2');
    expect(css).toContain('.modal-overlay--stack-3');
  });

  it('index.css defines commit message modal and working-tree preview classes', () => {
    const css = readFileSync(new URL('./styles/index.css', import.meta.url), 'utf8');
    expect(css).toContain('.git-history-view-msg-btn');
    expect(css).toContain('.git-history-body-text');
    expect(css).toMatch(/\.git-history-body-text[\s\S]{0,200}max-height:\s*100px/);
    expect(css).toContain('.git-commit-msg-modal-body');
    expect(css).toContain('.git-wt-commit-preview');
  });

  it('GitHistoryModal stacks at stack-2 and GitCommitFileModal at stack-3', () => {
    const historySrc = readFileSync(new URL('./components/GitHistoryModal.tsx', import.meta.url), 'utf8');
    const fileSrc = readFileSync(new URL('./components/GitCommitFileModal.tsx', import.meta.url), 'utf8');
    expect(historySrc).toContain('modal-overlay--stack-2');
    expect(fileSrc).toContain('modal-overlay--stack-3');
  });

  it('GitHistoryModal Escape onClose is guarded by fileOpen and showMessageModal', () => {
    const src = readFileSync(new URL('./components/GitHistoryModal.tsx', import.meta.url), 'utf8');
    expect(src).toContain('if (!fileOpen && !showMessageModal) onClose()');
  });

  it('GitHistoryModal full-message popup stacks at stack-3', () => {
    const src = readFileSync(new URL('./components/GitHistoryModal.tsx', import.meta.url), 'utf8');
    expect(src).toContain('title="Commit message"');
    expect(src).toContain('overlayClassName="modal-overlay--stack-3"');
    expect(src).toContain('className="git-commit-msg-modal"');
  });

  it('GitWorkingTreeModal commit confirm previews the draft message', () => {
    const src = readFileSync(new URL('./components/GitWorkingTreeModal.tsx', import.meta.url), 'utf8');
    expect(src).toContain('<pre className="git-wt-commit-preview">{message}</pre>');
  });

  it('GitLlmOpsModal stacks at stack-2 and its ConfirmDialog usage at stack-3', () => {
    const src = readFileSync(new URL('./components/GitLlmOpsModal.tsx', import.meta.url), 'utf8');
    const modalMatch = src.match(/<Modal[\s\S]*?overlayClassName="([^"]+)"/);
    expect(modalMatch?.[1]).toBe('modal-overlay--stack-2');
    const confirmMatch = src.match(/<ConfirmDialog[\s\S]*?overlayClassName="([^"]+)"/);
    expect(confirmMatch?.[1]).toBe('modal-overlay--stack-3');
  });

  it('GitLlmOpsModal Escape onClose is guarded by confirmDelete', () => {
    const src = readFileSync(new URL('./components/GitLlmOpsModal.tsx', import.meta.url), 'utf8');
    expect(src).toContain('if (!confirmDelete) onClose()');
  });

  it('GitLlmOpsModal send is fired-once and does not hang the confirm when canSubmit flips', () => {
    const src = readFileSync(new URL('./components/GitLlmOpsModal.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/sentRef\s*=\s*useRef\(false\)/);
    expect(src).toContain('if (sentRef.current) return');
    expect(src).toContain('busy={sent}');
    expect(src).toMatch(/if \(!canSubmit\)[\s\S]{0,160}setConfirmDelete\(false\)/);
  });

  it('GitLlmOpsModal has no cross-conversation recipient line', () => {
    const src = readFileSync(new URL('./components/GitLlmOpsModal.tsx', import.meta.url), 'utf8');
    expect(src).not.toContain('Sending to');
    expect(src).not.toContain('differsFromSelection');
    expect(src).not.toContain('projectName');
  });

  it('GitWorkingTreeModal wires llmOpsOpen into shouldCloseWorkingTreeModal', () => {
    const src = readFileSync(new URL('./components/GitWorkingTreeModal.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/shouldCloseWorkingTreeModal\(\{[\s\S]*\bllmOpsOpen\b[\s\S]*?\}\)/);
  });

  it('App submits git prompts via handleSend / handleSteer on the selected conversation only', () => {
    const src = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    expect(src).toContain('resolveGitPromptTarget');
    expect(src).toMatch(/gitPanel\.via === 'conversation' \? gitPanel\.conversation/);
    expect(src).toContain("handleSteer(text, [], 'queue')");
    expect(src).toContain('handleSend(text, selectedProfile.id, selectedProfile.agentType, selectedProfile.model, [])');
    expect(src).not.toMatch(/sendPrompt\(\{\s*projectId:\s*gitPromptTarget/);
    expect(src).not.toContain('gitPanelIsRunning');
  });

  it('GitWorkingTreeModal onClose does not cancel in-flight commit message generation', () => {
    const src = readFileSync(new URL('./components/GitWorkingTreeModal.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/onClose=\{\(\)\s*=>\s*\{[^}]*handleCancelGenerateCommitMessage/);
  });

  it('GitWorkingTreeModal uses clockwise running outline instead of top shimmer bar while generating', () => {
    const src = readFileSync(new URL('./components/GitWorkingTreeModal.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('./styles/index.css', import.meta.url), 'utf8');
    expect(src).not.toContain('git-wt-commit-shimmer');
    expect(src).toContain('git-wt-commit-box-wrap--generating');
    expect(css).not.toContain('.git-wt-commit-shimmer');
    expect(css).toContain('@property --git-wt-outline-angle');
    expect(css).toContain('.git-wt-commit-box-wrap--generating::after');
    expect(css).toContain('conic-gradient');
  });
});


