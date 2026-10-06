import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type BranchRecord } from '../branches.js';
import { type SetupConfig } from '../core/config.js';
import { branchExists, git, gitOk, worktreeAdd } from '../core/git.js';
import { logsDir } from '../core/paths.js';

export function forkWorktreePath(repoTop: string, name: string): string {
  return path.join(repoTop, '.claude', 'worktrees', `pit-${name}`);
}

/**
 * Keep .claude/worktrees out of the main checkout's `git status` and
 * `git add -A`. Uses .git/info/exclude, which is local and never committed.
 */
export function excludeWorktreesDir(repoTop: string): void {
  const exclude = path.join(gitOk(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoTop), 'info', 'exclude');
  const line = '/.claude/worktrees/';
  let current = '';
  try {
    current = fs.readFileSync(exclude, 'utf8');
  } catch {
    // no exclude file yet
  }
  if (current.split('\n').some((l) => l.trim() === line)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# added by pitstop\n${line}\n`);
}

function isWorktree(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/** Create (or reuse) the fork's worktree on branch pit/<name>, starting from the snapshot commit. */
export function createForkWorktree(branch: BranchRecord, setup: SetupConfig = {}): string {
  const dir = forkWorktreePath(branch.repoTop, branch.name);
  if (isWorktree(dir)) return dir;
  excludeWorktreesDir(branch.repoTop);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (branchExists(branch.repoTop, branch.gitBranch)) {
    gitOk(['worktree', 'add', '-q', dir, branch.gitBranch], branch.repoTop);
  } else {
    worktreeAdd(branch.repoTop, dir, branch.gitBranch, branch.snapshotCommit);
  }
  applySetup(branch, dir, setup);
  return dir;
}

/** Copy or symlink files the fork needs but git doesn't track, then start the setup command. */
export function applySetup(branch: BranchRecord, dir: string, setup: SetupConfig): void {
  for (const rel of setup.copy ?? []) {
    const src = path.join(branch.repoTop, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.cpSync(src, path.join(dir, rel), { recursive: true });
  }
  for (const rel of setup.symlink ?? []) {
    const src = path.join(branch.repoTop, rel);
    const dst = path.join(dir, rel);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst);
  }
  if (setup.run) {
    fs.mkdirSync(logsDir(), { recursive: true });
    const log = fs.openSync(path.join(logsDir(), `${branch.name}-setup.log`), 'a');
    const child = spawn(setup.run, {
      cwd: dir,
      shell: true,
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, PITSTOP_BRANCH: branch.name, PITSTOP_PORT_OFFSET: String(branch.portOffset) },
    });
    child.unref();
  }
}

/** Default WorktreeCreate behavior for sessions pitstop doesn't know about. */
export function createPlainWorktree(cwd: string, name: string): string {
  const top = gitOk(['rev-parse', '--show-toplevel'], cwd);
  const dir = path.join(top, '.claude', 'worktrees', name);
  if (isWorktree(dir)) return dir;
  excludeWorktreesDir(top);
  const branch = branchExists(top, `worktree-${name}`) ? undefined : `worktree-${name}`;
  if (branch) gitOk(['worktree', 'add', '-q', '-b', branch, dir, 'HEAD'], top);
  else git(['worktree', 'add', '-q', dir, `worktree-${name}`], top);
  return dir;
}
