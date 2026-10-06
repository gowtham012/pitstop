import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../core/paths.js';

export interface GuardInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Session's current directory (the parent checkout until the fork enters its worktree). */
  cwd: string;
  /** The fork's own worktree, once it exists. */
  worktree?: string;
  /** Main checkout of the repository. */
  repoTop: string;
}

export type GuardDecision = { deny: false } | { deny: true; reason: string };

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** git subcommands that change files, the index, refs or the remote. */
const MUTATING_GIT =
  /\bgit\b[^;&|\n]*?\b(checkout|switch|reset|stash|commit|merge|rebase|restore|clean|add|rm|mv|push|pull|cherry-pick|revert|apply|am|tag|worktree)\b/;

const ALLOW: GuardDecision = { deny: false };

/**
 * Resolve symlinks on the deepest part of `p` that exists, so a link inside
 * the worktree that points at the main checkout is judged by where it leads.
 */
export function realResolve(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Inside the main checkout but not inside the fork's own worktree (other forks' worktrees count as outside). */
function forbidden(p: string, g: GuardInput, own: string | undefined): boolean {
  const real = realResolve(p);
  const top = realResolve(g.repoTop);
  if (own && isInside(real, realResolve(own))) return false;
  return isInside(real, top);
}

/**
 * Keep a fork inside its own worktree. Native forks are only told to stay
 * out of the parent's checkout; this enforces it for file tools and catches
 * the common shell escapes. It is a guardrail against mistakes, not a
 * sandbox: a determined command can still get around regex checks.
 */
export function guardDecision(g: GuardInput): GuardDecision {
  const own = g.worktree;
  if (FILE_TOOLS.has(g.toolName)) {
    const raw = (g.toolInput.file_path ?? g.toolInput.notebook_path) as string | undefined;
    if (!raw) return ALLOW;
    const file = path.resolve(own ?? g.cwd, raw);
    if (!forbidden(file, g, own)) return ALLOW;
    return {
      deny: true,
      reason: own
        ? `pitstop: ${raw} is outside this fork's worktree (${own}). Edit the copy inside your worktree instead; the main session is still working in ${g.repoTop}.`
        : `pitstop: this fork has no worktree yet. Call EnterWorktree first, then edit files inside it. The main session is still working in ${g.repoTop}.`,
    };
  }
  if (g.toolName !== 'Bash') return ALLOW;

  const cmd = String(g.toolInput.command ?? '');
  const cwdOutside = !own || !isInside(realResolve(g.cwd), realResolve(own));
  if (cwdOutside && forbidden(g.cwd, g, own) && MUTATING_GIT.test(cmd)) {
    return {
      deny: true,
      reason: own
        ? `pitstop: this command would run git in ${g.cwd}, outside this fork's worktree (${own}). cd into your worktree first.`
        : `pitstop: this fork is still in the main checkout (${g.repoTop}), where the main session is working. Call EnterWorktree before running git commands that change files or branches.`,
    };
  }
  const base = own && !cwdOutside ? g.cwd : (own ?? g.cwd);
  const targets = [...absolutePaths(cmd), ...dirArguments(cmd).map((d) => path.resolve(base, d))];
  for (const p of targets) {
    if (forbidden(p, g, own) && (own || MUTATING_GIT.test(cmd) || /\bcd\b/.test(cmd))) {
      return {
        deny: true,
        reason: own
          ? `pitstop: the command touches ${p}, which is outside this fork's worktree (${own}). Use paths inside your worktree.`
          : `pitstop: the command touches ${p} in the main checkout. Call EnterWorktree first.`,
      };
    }
  }
  return ALLOW;
}

/** Absolute paths mentioned in a shell command (good enough for a guard, not a parser). */
export function absolutePaths(cmd: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s"'=:(])(\/[^\s"';|&)<>]+)/g;
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) if (m[1]) out.push(m[1]);
  return out;
}

/** Relative directories a command moves into or points git at: `cd X`, `git -C X`, `--git-dir=X`, `--work-tree X`. */
export function dirArguments(cmd: string): string[] {
  const out: string[] = [];
  const re = /(?:\bcd\s+|\bgit\s+-C\s+|--git-dir[=\s]+|--work-tree[=\s]+|\bpushd\s+)(["']?)([^\s"';|&)]+)\1/g;
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) {
    const d = m[2];
    if (d && !d.startsWith('/') && d !== '-' && !d.startsWith('$') && !d.startsWith('~')) out.push(d);
  }
  return out;
}
