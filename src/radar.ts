import fs from 'node:fs';
import { LIVE_STATES, type BranchRecord } from './branches.js';
import { statusAsync, touchedFilesAsync } from './core/git.js';

export interface Overlap {
  file: string;
  /** Labels of the sessions that changed it, e.g. ["main", "fix-login"]. */
  sessions: string[];
}

/** Files changed by two or more sessions. Pure. */
export function findOverlaps(touched: Map<string, string[]>): Overlap[] {
  const owners = new Map<string, string[]>();
  for (const [label, files] of touched) {
    for (const f of new Set(files)) {
      const list = owners.get(f) ?? [];
      list.push(label);
      owners.set(f, list);
    }
  }
  return [...owners.entries()]
    .filter(([, s]) => s.length > 1)
    .map(([file, sessions]) => ({ file, sessions: sessions.sort() }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** What every live session has changed: main's uncommitted files, each fork's own work since its snapshot. */
export async function collectTouched(
  repoTop: string,
  branches: BranchRecord[],
): Promise<Map<string, string[]>> {
  const touched = new Map<string, string[]>();
  touched.set(
    'main',
    (await statusAsync(repoTop)).map((e) => e.path),
  );
  await Promise.all(
    branches
      .filter((b) => LIVE_STATES.includes(b.state) && b.worktree && fs.existsSync(b.worktree))
      .map(async (b) =>
        touched.set(b.name, await touchedFilesAsync(b.worktree!, b.snapshotCommit)),
      ),
  );
  return touched;
}

export async function scanRadar(repoTop: string, branches: BranchRecord[]): Promise<Overlap[]> {
  return findOverlaps(await collectTouched(repoTop, branches));
}

export function overlapKey(o: Overlap): string {
  return `${o.file}::${o.sessions.join(',')}`;
}
