export type FileChangeStatus = 'modified' | 'created' | 'deleted' | 'renamed' | 'binary' | 'mode-change';

export interface DiffLine {
  kind: 'insert' | 'delete' | 'unchanged' | 'hunk' | 'meta';
  text: string;
}

export interface ParsedDiffFile {
  id: string;
  filePath: string;
  displayDir: string;
  displayName: string;
  chipLabel: string;
  oldPath?: string;
  newPath?: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  metaNotes?: string[];
  lines: DiffLine[];
}

export interface ParsedDiffResult {
  files: ParsedDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

function parseGitHeaderPaths(line: string): { aPath: string; bPath: string } | null {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length).trim();

  // Check quoted format: "a/..." "b/..."
  if (rest.startsWith('"')) {
    const closeA = rest.indexOf('" ', 0);
    if (closeA !== -1) {
      const a = rest.slice(1, closeA);
      let b = rest.slice(closeA + 2).trim();
      if (b.startsWith('"') && b.endsWith('"')) {
        b = b.slice(1, -1);
      }
      return {
        aPath: a.replace(/^a\//, ''),
        bPath: b.replace(/^b\//, ''),
      };
    }
  }

  const spaceB = rest.lastIndexOf(' b/');
  if (spaceB !== -1) {
    const a = rest.slice(0, spaceB);
    const b = rest.slice(spaceB + 3);
    return {
      aPath: a.replace(/^a\//, ''),
      bPath: b,
    };
  }

  const parts = rest.split(' ');
  if (parts.length >= 2) {
    return {
      aPath: parts[0].replace(/^a\//, ''),
      bPath: parts[1].replace(/^b\//, ''),
    };
  }

  return null;
}

/**
 * Parses raw unified git diff text into structured per-file diffs.
 */
export function parseGitDiff(diffText: string | null | undefined): ParsedDiffResult {
  if (!diffText || !diffText.trim()) {
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  }

  const rawLines = diffText.split('\n');
  const files: ParsedDiffFile[] = [];

  let currentFile: {
    oldPath?: string;
    newPath?: string;
    explicitStatus?: FileChangeStatus;
    binary: boolean;
    metaNotes: string[];
    lines: DiffLine[];
    inHunk: boolean;
  } | null = null;

  const finalizeCurrentFile = () => {
    if (!currentFile) return;

    let status: FileChangeStatus = currentFile.explicitStatus || 'modified';
    if (!currentFile.explicitStatus) {
      if (currentFile.binary) {
        status = 'binary';
      } else if (currentFile.oldPath && currentFile.newPath && currentFile.oldPath !== currentFile.newPath) {
        status = 'renamed';
      }
    }

    let filePath = currentFile.newPath || currentFile.oldPath || 'changes';
    if (status === 'deleted' && currentFile.oldPath) {
      filePath = currentFile.oldPath;
    } else if (status === 'renamed' && currentFile.oldPath && currentFile.newPath) {
      filePath = `${currentFile.oldPath} → ${currentFile.newPath}`;
    }

    let displayDir = '';
    let displayName = filePath;
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash !== -1 && status !== 'renamed') {
      displayDir = filePath.slice(0, lastSlash + 1);
      displayName = filePath.slice(lastSlash + 1);
    }

    let additions = 0;
    let deletions = 0;
    for (const l of currentFile.lines) {
      if (l.kind === 'insert') additions++;
      else if (l.kind === 'delete') deletions++;
    }

    files.push({
      id: `${filePath}-${files.length}`,
      filePath,
      displayDir,
      displayName,
      chipLabel: displayName,
      oldPath: currentFile.oldPath,
      newPath: currentFile.newPath,
      status,
      additions,
      deletions,
      binary: currentFile.binary,
      metaNotes: currentFile.metaNotes.length > 0 ? currentFile.metaNotes : undefined,
      lines: currentFile.lines,
    });

    currentFile = null;
  };

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];

    if (line.startsWith('diff --git ')) {
      finalizeCurrentFile();
      const parsed = parseGitHeaderPaths(line);
      currentFile = {
        oldPath: parsed?.aPath,
        newPath: parsed?.bPath,
        binary: false,
        metaNotes: [],
        lines: [],
        inHunk: false,
      };
      i++;
      continue;
    }

    if (line.trim() === 'Untracked files:') {
      finalizeCurrentFile();
      i++;
      while (i < rawLines.length) {
        const uLine = rawLines[i].trim();
        if (uLine && !uLine.startsWith('diff --git')) {
          const lastSlash = uLine.lastIndexOf('/');
          const displayDir = lastSlash !== -1 ? uLine.slice(0, lastSlash + 1) : '';
          const displayName = lastSlash !== -1 ? uLine.slice(lastSlash + 1) : uLine;
          files.push({
            id: `untracked-${uLine}-${files.length}`,
            filePath: uLine,
            displayDir,
            displayName,
            chipLabel: displayName,
            status: 'created',
            additions: 0,
            deletions: 0,
            binary: false,
            metaNotes: ['Untracked file'],
            lines: [],
          });
          i++;
        } else {
          break;
        }
      }
      continue;
    }

    if (!currentFile && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      currentFile = {
        binary: false,
        metaNotes: [],
        lines: [],
        inHunk: false,
      };
    }

    if (!currentFile && line.startsWith('@@')) {
      currentFile = {
        binary: false,
        metaNotes: [],
        lines: [],
        inHunk: true,
      };
    }

    if (!currentFile) {
      if (line.trim()) {
        currentFile = {
          binary: false,
          metaNotes: [],
          lines: [],
          inHunk: false,
        };
      } else {
        i++;
        continue;
      }
    }

    if (!currentFile.inHunk) {
      if (line.startsWith('new file mode')) {
        currentFile.explicitStatus = 'created';
      } else if (line.startsWith('deleted file mode')) {
        currentFile.explicitStatus = 'deleted';
      } else if (line.startsWith('rename from ')) {
        currentFile.oldPath = line.slice('rename from '.length).trim();
        currentFile.explicitStatus = 'renamed';
      } else if (line.startsWith('rename to ')) {
        currentFile.newPath = line.slice('rename to '.length).trim();
        currentFile.explicitStatus = 'renamed';
      } else if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
        currentFile.metaNotes.push(line);
      } else if (line.startsWith('Binary files ') && line.includes('differ')) {
        currentFile.binary = true;
        currentFile.explicitStatus = 'binary';
        currentFile.metaNotes.push('Binary file differs');
      } else if (line.startsWith('GIT binary patch')) {
        currentFile.binary = true;
        currentFile.explicitStatus = 'binary';
        currentFile.metaNotes.push('Git binary patch');
      } else if (line.startsWith('--- ')) {
        const path = line.slice(4).trim();
        if (path === '/dev/null') {
          currentFile.explicitStatus = 'created';
        } else if (!currentFile.oldPath) {
          currentFile.oldPath = path.replace(/^a\//, '');
        }
      } else if (line.startsWith('+++ ')) {
        const path = line.slice(4).trim();
        if (path === '/dev/null') {
          currentFile.explicitStatus = 'deleted';
        } else if (!currentFile.newPath) {
          currentFile.newPath = path.replace(/^b\//, '');
        }
      } else if (line.startsWith('@@')) {
        currentFile.inHunk = true;
        currentFile.lines.push({ kind: 'hunk', text: line });
      }
      i++;
      continue;
    }

    if (line.startsWith('@@')) {
      currentFile.lines.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      currentFile.lines.push({ kind: 'insert', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      currentFile.lines.push({ kind: 'delete', text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      currentFile.lines.push({ kind: 'meta', text: line });
    } else {
      currentFile.lines.push({
        kind: 'unchanged',
        text: line.startsWith(' ') ? line.slice(1) : line,
      });
    }

    i++;
  }

  finalizeCurrentFile();

  // Disambiguate chip labels when basenames collide (e.g. adapters/deepseek/index.ts vs src/index.ts)
  const nameCounts = new Map<string, number>();
  for (const f of files) {
    nameCounts.set(f.displayName, (nameCounts.get(f.displayName) || 0) + 1);
  }
  for (const f of files) {
    if ((nameCounts.get(f.displayName) || 0) > 1 && f.displayDir) {
      const segs = f.displayDir.replace(/\/$/, '').split('/');
      const parent = segs[segs.length - 1];
      f.chipLabel = parent ? `${parent}/${f.displayName}` : f.filePath;
    }
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  return { files, totalAdditions, totalDeletions };
}
