export function splitPath(filePath: string): { dir: string; file: string } {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash === -1) {
    return { dir: '', file: filePath };
  }
  return {
    dir: filePath.slice(0, lastSlash + 1),
    file: filePath.slice(lastSlash + 1),
  };
}

export function renderStatusBadge(status: string) {
  switch (status) {
    case 'modified':
      return <span className="git-wt-badge git-wt-badge--modified" title="Modified">M</span>;
    case 'new':
      return <span className="git-wt-badge git-wt-badge--new" title="New / Untracked">+</span>;
    case 'deleted':
      return <span className="git-wt-badge git-wt-badge--deleted" title="Deleted">D</span>;
    case 'renamed':
      return <span className="git-wt-badge git-wt-badge--renamed" title="Renamed">R</span>;
    case 'conflicted':
      return <span className="git-wt-badge git-wt-badge--conflicted" title="Conflicted">!</span>;
    default:
      return <span className="git-wt-badge" title={String(status)}>{String(status).slice(0, 1).toUpperCase()}</span>;
  }
}
