import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, gitOk, head, identityEnv, topLevel } from './git.js';

export interface Snapshot {
  /** Commit holding HEAD plus every uncommitted and untracked change. Equals `base` when clean. */
  commit: string;
  /** The HEAD the snapshot was taken on top of. */
  base: string;
  dirty: boolean;
  /** Ref that keeps the snapshot commit alive until a branch points at it. */
  ref?: string;
}

/**
 * Freeze the working tree of `cwd` into a commit without touching it.
 *
 * Uses a throwaway index (GIT_INDEX_FILE), so the real index, the files on
 * disk and any in-progress staging of the session being snapshotted are all
 * left exactly as they were.
 */
export function snapshotWorkingTree(cwd: string, label = 'fork'): Snapshot {
  const top = topLevel(cwd);
  const base = head(top);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitstop-idx-'));
  const indexFile = path.join(tmpDir, 'index');
  const env = { ...identityEnv(top), GIT_INDEX_FILE: indexFile };
  try {
    gitOk(['read-tree', 'HEAD'], top, env);
    gitOk(['add', '-A'], top, env);
    const tree = gitOk(['write-tree'], top, env);
    const baseTree = gitOk(['rev-parse', 'HEAD^{tree}'], top);
    if (tree === baseTree) return { commit: base, base, dirty: false };
    const commit = gitOk(
      ['commit-tree', tree, '-p', base, '-m', `pitstop snapshot for ${label}`],
      top,
      env,
    );
    const ref = `refs/pitstop/snapshots/${label}-${crypto.randomBytes(3).toString('hex')}`;
    git(['update-ref', ref, commit], top);
    return { commit, base, dirty: true, ref };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function dropSnapshotRef(top: string, ref: string | undefined): void {
  if (ref) git(['update-ref', '-d', ref], top);
}
