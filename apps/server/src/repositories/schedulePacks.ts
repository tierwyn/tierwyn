import type { Database } from 'better-sqlite3';
import type { SchedulePack, SchedulePackOrigin } from '@tierwyn/shared';

interface PackRow {
  slug: string;
  title: string;
  description: string;
  version: number;
  origin: string;
  doc: string;
  created_at: number;
  updated_at: number;
}

function parseDoc(row: PackRow): SchedulePack | undefined {
  try {
    const doc = JSON.parse(row.doc) as unknown;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined;
    const d = doc as SchedulePack;
    if (typeof d.slug !== 'string' || typeof d.title !== 'string' || !d.job) return undefined;
    return {
      ...d,
      slug: row.slug,
      title: row.title,
      description: row.description,
      version: row.version,
      origin: row.origin as SchedulePackOrigin,
    };
  } catch {
    return undefined;
  }
}

function writeRow(
  db: Database,
  pack: SchedulePack,
  origin: SchedulePackOrigin,
): void {
  const now = Date.now();
  const stored: SchedulePack = { ...pack, origin };
  db.prepare(
    `INSERT INTO schedule_packs (slug, title, description, version, origin, doc, created_at, updated_at)
     VALUES (@slug, @title, @description, @version, @origin, @doc, @now, @now)
     ON CONFLICT(slug) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       version = excluded.version,
       doc = excluded.doc,
       updated_at = excluded.updated_at
     WHERE schedule_packs.origin = @origin`,
  ).run({
    slug: pack.slug,
    title: pack.title,
    description: pack.description,
    version: pack.version,
    origin,
    doc: JSON.stringify(stored),
    now,
  });
}

/** Shipped first, then imported, slug ASC. Malformed `doc` rows are skipped. */
export function listPacks(db: Database): SchedulePack[] {
  const rows = db.prepare(
    `SELECT * FROM schedule_packs
     ORDER BY CASE origin WHEN 'shipped' THEN 0 ELSE 1 END, slug ASC`,
  ).all() as PackRow[];
  const out: SchedulePack[] = [];
  for (const row of rows) {
    const pack = parseDoc(row);
    if (pack) out.push(pack);
  }
  return out;
}

export function getPack(db: Database, slug: string): SchedulePack | undefined {
  const row = db.prepare('SELECT * FROM schedule_packs WHERE slug = ?').get(slug) as PackRow | undefined;
  if (!row) return undefined;
  return parseDoc(row);
}

/** Boot seed. Updates matching shipped rows; never touches origin='imported'. */
export function upsertShippedPack(db: Database, pack: SchedulePack): void {
  writeRow(db, pack, 'shipped');
}

/** Import + save-as-pack. Updates matching imported rows only. */
export function upsertImportedPack(db: Database, pack: SchedulePack): SchedulePack {
  const normalised: SchedulePack = { ...pack, origin: 'imported' };
  writeRow(db, normalised, 'imported');
  return getPack(db, pack.slug) ?? normalised;
}

export function deletePack(db: Database, slug: string): 'deleted' | 'not_found' | 'shipped' {
  const row = db.prepare('SELECT origin FROM schedule_packs WHERE slug = ?').get(slug) as { origin: string } | undefined;
  if (!row) return 'not_found';
  if (row.origin === 'shipped') return 'shipped';
  db.prepare('DELETE FROM schedule_packs WHERE slug = ?').run(slug);
  return 'deleted';
}
