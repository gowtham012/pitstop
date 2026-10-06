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
  /\bgit\s+(?:-C\s+\S+\s+)?(checkout|switch|reset|stash|commit|merge|rebase|restore|clean|add|rm|mv|push|pull|cherry-pick|revert|apply|am|tag|branch\s+-[dDmM])\b/;

const ALLOW: GuardDecision = { deny: false };

/**
 * Keep a fork inside its own worktree. Native forks are only told to stay
 * out of the parent's checkout; this enforces it.
 */
export function guardDecision(g: GuardInput): GuardDecision {
  const own = g.worktree;
  if (FILE_TOOLS.has(g.toolName)) {
    const raw = (g.toolInput.file_path ?? g.toolInput.notebook_path) as string | undefined;
    if (!raw) return ALLOW;
    const file = path.resolve(own ?? g.cwd, raw);
    if (own && isInside(file, own)) return ALLOW;
    if (isInside(file, g.repoTop)) {
      return {
        deny: true,
        reason: own
          ? `pitstop: ${raw} is outside this fork's worktree (${own}). Edit the copy inside your worktree instead; the main session is still working in ${g.repoTop}.`
          : `pitstop: this fork has no worktree yet. Call EnterWorktree first, then edit files inside it. The main session is still working in ${g.repoTop}.`,
      };
    }
    return ALLOW; // outside the repo entirely, e.g. /tmp
  }
  if (g.toolName === 'Bash') {
    const cmd = String(g.toolInput.command ?? '');
    if (!own && isInside(g.cwd, g.repoTop) && MUTATING_GIT.test(cmd)) {
      return {
        deny: true,
        reason: `pitstop: this fork is still in the main checkout (${g.repoTop}), where the main session is working. Call EnterWorktree before running git commands that change files or branches.`,
      };
    }
    if (own) {
      for (const p of absolutePaths(cmd)) {
        if (isInside(p, g.repoTop) && !isInside(p, own)) {
          return {
            deny: true,
            reason: `pitstop: the command touches ${p}, which is outside this fork's worktree (${own}). Use paths inside your worktree.`,
          };
        }
      }
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
