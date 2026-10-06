import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Root of pitstop's own state. Overridable for tests and multi-profile setups. */
export function pitstopHome(): string {
  return process.env.PITSTOP_HOME ?? path.join(os.homedir(), '.pitstop');
}

export function sessionsDir(): string {
  return path.join(pitstopHome(), 'sessions');
}

export function inboxDir(sessionId: string): string {
  return path.join(pitstopHome(), 'inbox', sessionId);
}

export function logsDir(): string {
  return path.join(pitstopHome(), 'logs');
}

export function repoStateDir(repoId: string): string {
  return path.join(pitstopHome(), 'repos', repoId);
}

export function branchesDir(repoId: string): string {
  return path.join(repoStateDir(repoId), 'branches');
}

/** Stable id for a repository, shared by all of its worktrees. */
export function repoIdFor(gitCommonDir: string): string {
  let real = gitCommonDir;
  try {
    real = fs.realpathSync(gitCommonDir);
  } catch {
    // keep the given path
  }
  return crypto.createHash('sha1').update(real).digest('hex').slice(0, 12);
}

/** Turn a task description into a short branch-safe name. */
export function slugify(text: string, max = 32): string {
  const full = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = full.slice(0, max);
  // Cut at a word boundary rather than mid-word, when that keeps most of it.
  if (full.length > max && full[max] !== '-') {
    const cut = slug.lastIndexOf('-');
    if (cut >= max / 2) slug = slug.slice(0, cut);
  }
  return slug.replace(/-+$/g, '') || 'fork';
}

/** True when `child` is `parent` or lives somewhere below it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
