const movingProjects = new Set<string>();

export const PROJECT_MOVING_ERROR = 'project folder is being moved — retry in a moment';

export function beginProjectMove(id: string): boolean {
  if (movingProjects.has(id)) return false;
  movingProjects.add(id);
  return true;
}

export function endProjectMove(id: string): void {
  movingProjects.delete(id);
}

export function isProjectMoving(id: string): boolean {
  return movingProjects.has(id);
}
