import path from 'node:path';
import { repoStateDir } from '../core/paths.js';
import { readJson } from '../core/store.js';

/** Written while a `pit` UI is open, so `pit fork` elsewhere knows a UI will open cloud and agent panes. */
export function tuiPidFile(repoId: string): string {
  return path.join(repoStateDir(repoId), 'tui.json');
}

/** True when a `pit` UI is running for this repo. */
export function tuiRunning(repoId: string): boolean {
  const rec = readJson<{ pid: number }>(tuiPidFile(repoId));
  if (!rec?.pid) return false;
  try {
    process.kill(rec.pid, 0);
    return true;
  } catch {
    return false;
  }
}
