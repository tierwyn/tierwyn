import { useState, useMemo } from 'react';
import { isOpenableExtension } from '@tierwyn/shared';
import { TodoList } from './TodoList';

function isOpenableExt(p: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return !!m && isOpenableExtension(m[1].toLowerCase());
}

/**
 * Strip a file:// scheme (with optional localhost/) and a trailing #L… line
 * hash so the value handed to onOpenFile is a bare path that GET /files
 * accepts. Mirrors the cleanup in MarkdownBody's `a` handler.
 */
function cleanFilePath(value: string): string {
  let p = value;
  if (p.startsWith('file://')) {
    p = p.slice(7);
    if (p.startsWith('localhost/')) p = p.slice(9);
  }
  const hashIdx = p.indexOf('#');
  if (hashIdx >= 0) p = p.slice(0, hashIdx);
  return p;
}

export interface DiffPair {
  before: string;
  after: string;
}

/**
 * Parse a unified git diff or Copilot patch string for a specific file path into before/after text.
 */
export function parseDiffOrPatchForFile(diffText: string, targetPath?: string): DiffPair | null {
  if (!diffText || typeof diffText !== 'string') return null;
  const lines = diffText.split('\n');
  const targetNorm = targetPath ? targetPath.replace(/\\/g, '/').toLowerCase() : undefined;

  // 1. Check for Copilot patch format: *** Begin Patch ... *** Update File: path ...
  if (diffText.includes('*** Begin Patch') || diffText.includes('*** Update File:') || diffText.includes('*** Add File:')) {
    let matching = !targetNorm;
    let found = false;
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('*** Update File:') || line.startsWith('*** Add File:')) {
        const filePath = line.split(':', 2)[1]?.trim().replace(/\\/g, '/').toLowerCase() ?? '';
        if (!targetNorm || targetNorm.endsWith(filePath) || filePath.endsWith(targetNorm)) {
          matching = true;
          found = true;
        } else {
          matching = false;
        }
      } else if (line.startsWith('*** End Patch')) {
        matching = false;
      } else if (matching) {
        if (line.startsWith('@@')) {
          continue;
        } else if (line.startsWith('-')) {
          oldLines.push(line.slice(1));
        } else if (line.startsWith('+')) {
          newLines.push(line.slice(1));
        } else if (line.startsWith(' ')) {
          oldLines.push(line.slice(1));
          newLines.push(line.slice(1));
        } else if (line.trim().length > 0) {
          oldLines.push(line);
          newLines.push(line);
        }
      }
    }
    if (found || (!targetNorm && (oldLines.length > 0 || newLines.length > 0))) {
      return { before: oldLines.join('\n'), after: newLines.join('\n') };
    }
  }

  // 2. Check for unified diff: diff --git or --- a/... +++ b/...
  if (diffText.includes('--- ') && diffText.includes('+++ ')) {
    let matching = !targetNorm;
    let found = false;
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        matching = !targetNorm;
      } else if (line.startsWith('+++ ')) {
        let p = line.slice(4).trim();
        if (p.startsWith('b/')) p = p.slice(2);
        const filePath = p.replace(/\\/g, '/').toLowerCase();
        if (!targetNorm || targetNorm.endsWith(filePath) || filePath.endsWith(targetNorm)) {
          matching = true;
          found = true;
        } else {
          matching = false;
        }
      } else if (matching) {
        if (line.startsWith('@@')) {
          continue;
        } else if (line.startsWith('-')) {
          oldLines.push(line.slice(1));
        } else if (line.startsWith('+')) {
          newLines.push(line.slice(1));
        } else if (line.startsWith(' ')) {
          oldLines.push(line.slice(1));
          newLines.push(line.slice(1));
        }
      }
    }
    if (found || (!targetNorm && (oldLines.length > 0 || newLines.length > 0))) {
      return { before: oldLines.join('\n'), after: newLines.join('\n') };
    }
  }

  return null;
}

/**
 * Pull old/new (or write-content) strings from a tool_call input so file_change
 * cards and the turn-info modal can render an inline DiffViewer.
 */
export function extractDiffPairFromToolInput(input: unknown, targetPath?: string): DiffPair | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const keys = Object.keys(rec);
  const oldKey = keys.find((k) =>
    ['old_string', 'old_str', 'oldstring', 'targetcontent', 'target', 'old', 'oldtext', 'oldstr'].includes(k.toLowerCase()),
  );
  const newKey = keys.find((k) =>
    ['new_string', 'new_str', 'newstring', 'replacementcontent', 'replacement', 'new', 'newtext', 'newstr'].includes(k.toLowerCase()),
  );
  if (oldKey && newKey) {
    return { before: String(rec[oldKey] ?? ''), after: String(rec[newKey] ?? '') };
  }

  // Check if input has a structured diff array (e.g. Kiro ACP update.content: [{ type: 'diff', oldText, newText }])
  if (Array.isArray(rec.content)) {
    const diffItems = rec.content.filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && (item as Record<string, unknown>).type === 'diff',
    );
    if (diffItems.length > 0) {
      const targetNorm = targetPath ? targetPath.replace(/\\/g, '/').toLowerCase() : undefined;
      const matched = targetNorm
        ? diffItems.find((d) => {
            const p = typeof d.path === 'string' ? d.path.replace(/\\/g, '/').toLowerCase() : '';
            return p && (targetNorm.endsWith(p) || p.endsWith(targetNorm));
          }) ?? diffItems[0]
        : diffItems[0];
      if (matched) {
        return {
          before: typeof matched.oldText === 'string' ? matched.oldText : '',
          after: typeof matched.newText === 'string' ? matched.newText : '',
        };
      }
    }
  }

  // Check if input has patch/diff string (e.g. Copilot apply_patch input: { patch: '*** Begin Patch...' })
  const patchKey = keys.find((k) => {
    const l = k.toLowerCase();
    return l === 'patch' || l === 'diff';
  });
  if (patchKey && typeof rec[patchKey] === 'string') {
    const parsed = parseDiffOrPatchForFile(rec[patchKey] as string, targetPath);
    if (parsed) return parsed;
  }

  const contentKey = keys.find((k) => {
    const l = k.toLowerCase();
    // Cursor edit/write tools stream the new body as streamContent.
    // Antigravity write_to_file uses CodeContent (native DB) / Contents (tests).
    return l === 'content' || l === 'new_content' || l === 'streamcontent'
      || l === 'codecontent' || l === 'contents';
  });
  if (contentKey) {
    const val = rec[contentKey];
    if (typeof val === 'string') {
      return { before: '', after: val };
    }
    // If content is not a string (e.g. array of diff objects already checked or complex structure), do not convert to "[object Object]"
    return null;
  }
  return null;
}

/** Path keys used across adapters for the file a tool call targets. */
export function toolInputFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  for (const key of ['path', 'Path', 'file_path', 'filePath', 'TargetFile', 'AbsolutePath', 'target_file', 'filename']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
}

export interface DiffRenderBlock {
  id: string;
  type: 'changed' | 'unchanged';
  lines: DiffLine[];
}

export interface DiffResult {
  blocks: DiffRenderBlock[];
  addedCount: number;
  removedCount: number;
}

export function computeDiff(target: string, replacement: string): DiffResult {
  const oldLines = target.length === 0 ? [] : target.split('\n');
  const newLines = replacement.length === 0 ? [] : replacement.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  if (target === replacement) {
    const blocks: DiffRenderBlock[] = m > 0
      ? [{ id: 'block-0', type: 'unchanged', lines: oldLines.map((text) => ({ type: 'unchanged' as const, text })) }]
      : [];
    return { blocks, addedCount: 0, removedCount: 0 };
  }

  // Common prefix
  let prefixCount = 0;
  while (prefixCount < m && prefixCount < n && oldLines[prefixCount] === newLines[prefixCount]) {
    prefixCount++;
  }

  // Common suffix
  let suffixCount = 0;
  while (
    suffixCount < (m - prefixCount) &&
    suffixCount < (n - prefixCount) &&
    oldLines[m - 1 - suffixCount] === newLines[n - 1 - suffixCount]
  ) {
    suffixCount++;
  }

  const rawHunks: DiffLine[] = [];
  let addedCount = 0;
  let removedCount = 0;

  for (let i = 0; i < prefixCount; i++) {
    rawHunks.push({ type: 'unchanged', text: oldLines[i] });
  }

  const midOld = oldLines.slice(prefixCount, m - suffixCount);
  const midNew = newLines.slice(prefixCount, n - suffixCount);
  const midM = midOld.length;
  const midN = midNew.length;

  if (midM === 0) {
    for (let j = 0; j < midN; j++) {
      rawHunks.push({ type: 'added', text: midNew[j] });
      addedCount++;
    }
  } else if (midN === 0) {
    for (let i = 0; i < midM; i++) {
      rawHunks.push({ type: 'removed', text: midOld[i] });
      removedCount++;
    }
  } else if (midM * midN > 250_000) {
    for (let i = 0; i < midM; i++) {
      rawHunks.push({ type: 'removed', text: midOld[i] });
      removedCount++;
    }
    for (let j = 0; j < midN; j++) {
      rawHunks.push({ type: 'added', text: midNew[j] });
      addedCount++;
    }
  } else {
    const dp: number[][] = Array.from({ length: midM + 1 }, () => Array(midN + 1).fill(0));
    for (let i = 1; i <= midM; i++) {
      for (let j = 1; j <= midN; j++) {
        if (midOld[i - 1] === midNew[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const midHunks: DiffLine[] = [];
    let i = midM;
    let j = midN;

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && midOld[i - 1] === midNew[j - 1]) {
        midHunks.unshift({ type: 'unchanged', text: midOld[i - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        midHunks.unshift({ type: 'added', text: midNew[j - 1] });
        addedCount++;
        j--;
      } else {
        midHunks.unshift({ type: 'removed', text: midOld[i - 1] });
        removedCount++;
        i--;
      }
    }

    rawHunks.push(...midHunks);
  }

  for (let i = m - suffixCount; i < m; i++) {
    rawHunks.push({ type: 'unchanged', text: oldLines[i] });
  }

  const blocks: DiffRenderBlock[] = [];
  let currentBlock: DiffRenderBlock | null = null;

  rawHunks.forEach((hunk, idx) => {
    const isUnchanged = hunk.type === 'unchanged';
    const blockType = isUnchanged ? 'unchanged' : 'changed';
    if (!currentBlock || currentBlock.type !== blockType) {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = { id: `block-${idx}`, type: blockType, lines: [hunk] };
    } else {
      currentBlock.lines.push(hunk);
    }
  });
  if (currentBlock) blocks.push(currentBlock);

  return { blocks, addedCount, removedCount };
}

export function DiffViewer({
  target,
  replacement,
  foldUnchanged = false,
  className,
}: {
  target: string;
  replacement: string;
  foldUnchanged?: boolean;
  className?: string;
}) {
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({});

  const { blocks, addedCount, removedCount } = useMemo(
    () => computeDiff(target, replacement),
    [target, replacement],
  );

  const foldableBlocks = useMemo(
    () => (foldUnchanged ? blocks.filter((b) => b.type === 'unchanged' && b.lines.length > 8) : []),
    [blocks, foldUnchanged],
  );
  const allExpanded = foldableBlocks.length > 0 && foldableBlocks.every((b) => expandedBlocks[b.id]);

  const toggleAll = () => {
    if (allExpanded) {
      setExpandedBlocks({});
    } else {
      const next: Record<string, boolean> = {};
      for (const b of foldableBlocks) next[b.id] = true;
      setExpandedBlocks(next);
    }
  };

  const toggleBlock = (id: string) => {
    setExpandedBlocks((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const containerClass = className ? `diff-container ${className}` : 'diff-container';

  return (
    <div className={containerClass}>
      <div className="diff-header-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>hunk summary</span>
          {foldUnchanged && foldableBlocks.length > 0 && (
            <button
              type="button"
              className="diff-fold-toggle-btn"
              onClick={toggleAll}
            >
              {allExpanded ? 'Collapse unchanged' : 'Expand all'}
            </button>
          )}
        </div>
        <span className="diff-stats-badge">
          <span className="diff-stat-removed">-{removedCount}</span>
          <span className="diff-stat-added">+{addedCount}</span>
        </span>
      </div>
      <pre className="diff-pre">
        <div className="diff-lines-container">
          {blocks.map((block) => {
            if (foldUnchanged && block.type === 'unchanged') {
              const totalLines = block.lines.length;
              const isLong = totalLines > 8;
              const isExpanded = !!expandedBlocks[block.id];

              if (isLong && !isExpanded) {
                const head = block.lines.slice(0, 3);
                const tail = block.lines.slice(totalLines - 3);
                const hiddenCount = totalLines - 6;

                return (
                  <div key={block.id}>
                    {head.map((line, lIdx) => (
                      <div key={`head-${lIdx}`} className="diff-line diff-line-unchanged">
                        <span className="diff-indicator"> </span>
                        <span className="diff-text">{line.text || '\u00A0'}</span>
                      </div>
                    ))}
                    <div
                      className="diff-fold-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleBlock(block.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleBlock(block.id);
                        }
                      }}
                    >
                      <span className="diff-fold-indicator">⇅</span>
                      <span className="diff-fold-text">Expand {hiddenCount} unchanged lines</span>
                    </div>
                    {tail.map((line, lIdx) => (
                      <div key={`tail-${lIdx}`} className="diff-line diff-line-unchanged">
                        <span className="diff-indicator"> </span>
                        <span className="diff-text">{line.text || '\u00A0'}</span>
                      </div>
                    ))}
                  </div>
                );
              }
            }

            return (
              <div key={block.id}>
                {block.lines.map((line, lIdx) => {
                  let lineClass = 'diff-line-unchanged';
                  let indicator = ' ';
                  if (line.type === 'removed') { lineClass = 'diff-line-delete'; indicator = '-'; }
                  else if (line.type === 'added') { lineClass = 'diff-line-insert'; indicator = '+'; }
                  return (
                    <div key={lIdx} className={`diff-line ${lineClass}`}>
                      <span className="diff-indicator">{indicator}</span>
                      <span className="diff-text">{line.text || '\u00A0'}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </pre>
    </div>
  );
}

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  onOpenFile?: (p: string) => void;
}

export function ToolInputDisplay({ input, onOpenFile }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const [isCodeExpanded, setIsCodeExpanded] = useState(false);

  if (!input || typeof input !== 'object') {
    return <pre className="raw-json">{String(input)}</pre>;
  }

  if (showRaw) {
    return (
      <div>
        <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={(e) => { e.stopPropagation(); setShowRaw(false); }} className="tool-raw-toggle">
            Show Formatted
          </button>
        </div>
        <pre className="raw-json">{JSON.stringify(input, null, 2)}</pre>
      </div>
    );
  }

  const keys = Object.keys(input);
  const targetKey = keys.find(k => {
    const l = k.toLowerCase();
    return l === 'targetcontent' || l === 'old_string' || l === 'oldstring' || l === 'old';
  });
  const replacementKey = keys.find(k => {
    const l = k.toLowerCase();
    return l === 'replacementcontent' || l === 'new_string' || l === 'newstring' || l === 'new';
  });
  const multiKey = keys.find(k => {
    const l = k.toLowerCase();
    return l === 'replacementchunks' || l === 'edits' || l === 'chunks';
  });
  const todoKey = keys.find(k => {
    const l = k.toLowerCase();
    return l === 'todos' || l === 'tasks' || l === 'todolist';
  });

  const isDiffArray = Array.isArray(input.content) && input.content.some(
    (item: unknown) => item !== null && typeof item === 'object' && (item as Record<string, unknown>).type === 'diff'
  );

  const isSingleReplace = targetKey !== undefined && replacementKey !== undefined;
  const isMultiReplace = multiKey !== undefined && Array.isArray(input[multiKey]);
  const isTodoList = todoKey !== undefined && Array.isArray(input[todoKey]);

  const pathKeys = ['TargetFile', 'AbsolutePath', 'SearchPath', 'Cwd', 'TargetPath', 'Path', 'Target', 'filepath', 'file_path'];
  const codeKeys = ['CodeContent', 'CommandLine', 'Query', 'content', 'text', 'code', 'diff', 'patch'];

  const pathFields: { key: string; value: string }[] = [];
  const codeFields: { key: string; value: unknown }[] = [];
  const otherFields: { key: string; value: unknown }[] = [];

  for (const key of keys) {
    if (key === targetKey || key === replacementKey || key === multiKey || key === todoKey) continue;
    if (isDiffArray && key.toLowerCase() === 'content') continue;
    const val = input[key];
    if (pathKeys.some(k => k.toLowerCase() === key.toLowerCase()) && typeof val === 'string') {
      pathFields.push({ key, value: val });
    } else if (codeKeys.some(k => k.toLowerCase() === key.toLowerCase())) {
      codeFields.push({ key, value: val });
    } else {
      otherFields.push({ key, value: val });
    }
  }

  return (
    <div className="tool-call-formatted">
      <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={(e) => { e.stopPropagation(); setShowRaw(true); }} className="tool-raw-toggle">
          Show Raw JSON
        </button>
      </div>

      {pathFields.map(field => {
        const cleanPath = cleanFilePath(field.value);
        return (
          <div key={field.key} className="formatted-field-path">
            <span className="field-label">{field.key}:</span>
            {isOpenableExt(cleanPath) && onOpenFile ? (
              <button
                type="button"
                className="field-path-value file-path-link"
                title={cleanPath}
                onClick={(e) => { e.stopPropagation(); onOpenFile(cleanPath); }}
              >
                {field.value}
              </button>
            ) : (
              <code className="field-path-value">{field.value}</code>
            )}
          </div>
        );
      })}

      {isTodoList && (
        <div className="formatted-field-todos" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span className="field-label">Tasks / Todos:</span>
            {input.merge === true && (
              <span
                title="Status-only merge patch — labels may show Task id until content is known from an earlier write"
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--ui)',
                  fontWeight: 600,
                  color: 'var(--text-3)',
                  background: 'var(--surface-3)',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  padding: '1px 6px',
                }}
              >
                merge
              </span>
            )}
          </div>
          <TodoList todos={input[todoKey!] as unknown[]} />
        </div>
      )}

      {otherFields.length > 0 && (
        <div className="formatted-fields-grid">
          {otherFields
            // merge is shown as a badge on the todo block when present
            .filter((field) => !(isTodoList && field.key.toLowerCase() === 'merge'))
            .map(field => (
            <div key={field.key} className="formatted-field-row">
              <span className="field-label">{field.key}:</span>
              <span className="field-value">
                {typeof field.value === 'object' ? JSON.stringify(field.value) : String(field.value)}
              </span>
            </div>
          ))}
        </div>
      )}

      {isSingleReplace && (
        <div className="formatted-field-code">
          <span className="field-label">File Edit Diff:</span>
          <DiffViewer target={String(input[targetKey!])} replacement={String(input[replacementKey!])} />
        </div>
      )}

      {isMultiReplace && (
        <div className="formatted-field-code">
          <span className="field-label">File Edit Diffs:</span>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {(input[multiKey!] as any[]).map((chunk: unknown, index: number) => {
            if (chunk && typeof chunk === 'object') {
              const c = chunk as Record<string, unknown>;
              const chunkKeys = Object.keys(c);
              const ct = chunkKeys.find(ck => {
                const cl = ck.toLowerCase();
                return cl === 'targetcontent' || cl === 'old_string' || cl === 'oldstring' || cl === 'old' || cl === 'oldtext';
              });
              const cr = chunkKeys.find(ck => {
                const cl = ck.toLowerCase();
                return cl === 'replacementcontent' || cl === 'new_string' || cl === 'newstring' || cl === 'new' || cl === 'newtext';
              });
              if (ct !== undefined && cr !== undefined) {
                return (
                  <div key={index} style={{ marginBottom: index < (input[multiKey!] as unknown[]).length - 1 ? 12 : 0 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 4, fontFamily: 'var(--ui)', fontWeight: 600 }}>
                      CHUNK {index + 1}
                    </div>
                    <DiffViewer target={String(c[ct])} replacement={String(c[cr])} />
                  </div>
                );
              }
            }
            return null;
          })}
        </div>
      )}

      {codeFields.map(field => {
        const codeString = typeof field.value === 'string'
          ? field.value
          : JSON.stringify(field.value, null, 2);
        const lines = codeString.split('\n');
        const isLong = lines.length > 8;
        const displayed = isLong && !isCodeExpanded ? lines.slice(0, 6).join('\n') + '\n...' : codeString;

        return (
          <div key={field.key} className="formatted-field-code">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span className="field-label">{field.key}:</span>
              {isLong && (
                <button
                  onClick={(e) => { e.stopPropagation(); setIsCodeExpanded(p => !p); }}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 10, fontWeight: 600, padding: '2px 6px' }}
                >
                  {isCodeExpanded ? 'Show Less ▴' : 'Show More ▾'}
                </button>
              )}
            </div>
            <pre className="field-code-pre"><code>{displayed}</code></pre>
          </div>
        );
      })}
    </div>
  );
}
