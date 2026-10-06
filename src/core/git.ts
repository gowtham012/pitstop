import path from 'node:path';
import { run, runSync, type RunResult } from './exec.js';
import { repoIdFor } from './paths.js';

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly result: RunResult,
  ) {
    super(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** Identity used when the repo has no user.name/email, so pitstop's own commits never fail. */
export function identityEnv(cwd: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  const name = runSync('git', ['config', 'user.name'], { cwd }).stdout.trim();
  const email = runSync('git', ['config', 'user.email'], { cwd }).stdout.trim();
  if (!name) {
    env.GIT_AUTHOR_NAME ??= 'pitstop';
    env.GIT_COMMITTER_NAME ??= 'pitstop';
  }
  if (!email) {
    env.GIT_AUTHOR_EMAIL ??= 'pitstop@localhost';
    env.GIT_COMMITTER_EMAIL ??= 'pitstop@localhost';
  }
  return env;
}

export function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): RunResult {
  return runSync('git', args, { cwd, env });
}

export function gitAsync(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return run('git', args, { cwd, env });
}

/** Run git and return trimmed stdout, throwing on failure. */
export function gitOk(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const res = git(args, cwd, env);
  if (res.code !== 0) throw new GitError(args, res);
  return res.stdout.trim();
}

export function isGitRepo(cwd: string): boolean {
  return git(['rev-parse', '--is-inside-work-tree'], cwd).stdout.trim() === 'true';
}

export function topLevel(cwd: string): string {
  return gitOk(['rev-parse', '--show-toplevel'], cwd);
}

export function commonDir(cwd: string): string {
  const dir = gitOk(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return path.resolve(cwd, dir);
}

export function head(cwd: string): string {
  return gitOk(['rev-parse', 'HEAD'], cwd);
}

export function currentBranch(cwd: string): string | undefined {
  const res = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  return res.code === 0 ? res.stdout.trim() : undefined;
}

export interface RepoContext {
  top: string;
  commonDir: string;
  repoId: string;
  name: string;
}

/** The main checkout of the repository that `cwd` belongs to (even from inside a worktree). */
export function repoContext(cwd: string): RepoContext {
  const common = commonDir(cwd);
  // For a normal repo the common dir is <main>/.git; worktrees share it.
  const mainTop = path.basename(common) === '.git' ? path.dirname(common) : topLevel(cwd);
  return { top: mainTop, commonDir: common, repoId: repoIdFor(common), name: path.basename(mainTop) };
}

export interface StatusEntry {
  code: string;
  path: string;
}

/** `git status --porcelain=v1 -z` including untracked files. Renames report the new path. */
export function parsePorcelainZ(out: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (!item || item.length < 4) continue;
    const code = item.slice(0, 2);
    entries.push({ code, path: item.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') i++; // skip the original path
  }
  return entries;
}

export function status(cwd: string): StatusEntry[] {
  return parsePorcelainZ(gitOk(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd));
}

export async function statusAsync(cwd: string): Promise<StatusEntry[]> {
  const res = await gitAsync(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  return res.code === 0 ? parsePorcelainZ(res.stdout) : [];
}

export function dirtyFiles(cwd: string): string[] {
  return status(cwd).map((e) => e.path);
}

export function isClean(cwd: string): boolean {
  return status(cwd).length === 0;
}

/** Files changed by commits in base..HEAD plus anything uncommitted in the worktree. */
export async function touchedFilesAsync(cwd: string, base?: string): Promise<string[]> {
  const files = new Set<string>();
  if (base) {
    const diff = await gitAsync(['diff', '--name-only', `${base}..HEAD`], cwd);
    if (diff.code === 0) diff.stdout.split('\n').filter(Boolean).forEach((f) => files.add(f));
  }
  for (const e of await statusAsync(cwd)) files.add(e.path);
  return [...files].sort();
}

export function worktreeAdd(top: string, dir: string, branch: string, commit: string): void {
  gitOk(['worktree', 'add', '-q', '-b', branch, dir, commit], top);
}

export function worktreeRemove(top: string, dir: string, force = false): RunResult {
  return git(['worktree', 'remove', ...(force ? ['--force'] : []), dir], top);
}

export function branchExists(top: string, branch: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], top).code === 0;
}

export function deleteBranch(top: string, branch: string, force = false): RunResult {
  return git(['branch', force ? '-D' : '-d', branch], top);
}

/** Stage and commit everything in `cwd`. Returns false when there was nothing to commit. */
export function commitAll(cwd: string, message: string): boolean {
  gitOk(['add', '-A'], cwd);
  if (git(['diff', '--cached', '--quiet'], cwd).code === 0) return false;
  gitOk(['commit', '-q', '--no-verify', '-m', message], cwd, identityEnv(cwd));
  return true;
}

export function revCount(cwd: string, range: string): number {
  const res = git(['rev-list', '--count', range], cwd);
  return res.code === 0 ? Number(res.stdout.trim()) : 0;
}
