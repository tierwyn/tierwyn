/** Catalogue model resource path — IDs may contain `/`, `:`, tabs (legacy agy). */
export function modelResourcePath(id: string): string {
  return `/models/${encodeURIComponent(id)}`;
}
