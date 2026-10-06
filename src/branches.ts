import path from 'node:path';
import { branchesDir, sessionsDir } from './core/paths.js';
import { listJson, readJson, writeJsonAtomic } from './core/store.js';

export type BranchState =
  'starting' | 'running' | 'idle' | 'done' | 'failed' | 'deferred' | 'merged' | 'discarded';

export const LIVE_STATES: BranchState[] = [
  'starting',
  'running',
  'idle',
  'done',
  'failed',
  'deferred',
];

export interface BranchRecord {
  name: string;
  repoId: string;
  repoTop: string;
  task: string;
  preset?: string;
  /** 'pane' opens next to main; 'bg' runs with no pane. */
  mode: 'pane' | 'bg';
  parentSessionId: string;
  parentSessionName?: string;
  /** Set when this fork was made from another fork. */
  parentBranch?: string;
  sessionId?: string;
  shortId?: string;
  sessionName: string;
  /** Where the fork runs. Missing on records from before cloud and agent forks: treat as 'claude'. */
  kind?: 'claude' | 'cloud' | 'agent';
  /** Key of `agents` in config, for kind 'agent'. */
  agent?: string;
  /** For kind 'cloud': the cloud session, once its id appears on screen. */
  cloudSessionId?: string;
  cloudUrl?: string;
  /** For kind 'cloud': the remote head of the fork's branch the last time it was checked. */
  remoteHead?: string;
  /** For kinds 'cloud' and 'agent': the program pitstop runs in the fork's pane. */
  launch?: { cmd: string; args: string[]; cwd: string; env?: Record<string, string> };
  /** For kind 'agent': arguments that reopen the agent's latest session after a restart. */
  resumeArgs?: string[];
  /** 'summary' for cloud and agent forks, which start from a conversation digest. */
  forkMethod: 'native' | 'sealed' | 'summary';
  /** Commit with the parent's uncommitted work frozen in; the fork's own work is snapshot..branch. */
  snapshotCommit: string;
  snapshotRef?: string;
  baseCommit: string;
  gitBranch: string;
  worktree?: string;
  portSlot: number;
  /** Exported to the fork as PITSTOP_PORT_OFFSET (slot × portStep). */
  portOffset: number;
  state: BranchState;
  budgetUsd?: number;
  testGate?: boolean;
  pendingAtFork?: string[];
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergeStrategy?: string;
  note?: string;
  /** Kept for `pit report` because the branch itself is deleted after a merge. */
  commits?: string[];
  diffstat?: string;
  filesChanged?: string[];
  gate?: { ok: boolean; code: number; durationMs: number; at: string };
  lastMessage?: string;
  costUsd?: number;
}

export function branchKind(b: BranchRecord): 'claude' | 'cloud' | 'agent' {
  return b.kind ?? 'claude';
}

/** Index from a Claude session id to pitstop's view of it. Written by pit and by hooks. */
export interface SessionRecord {
  sessionId: string;
  role: 'main' | 'fork';
  repoId?: string;
  branch?: string;
  name?: string;
  cwd?: string;
  transcriptPath?: string;
  startedAt?: string;
  lastPromptAt?: string;
  endedAt?: string;
}

export function branchFile(repoId: string, name: string): string {
  return path.join(branchesDir(repoId), `${name}.json`);
}

export function saveBranch(b: BranchRecord): BranchRecord {
  b.updatedAt = new Date().toISOString();
  writeJsonAtomic(branchFile(b.repoId, b.name), b);
  return b;
}

export function loadBranch(repoId: string, name: string): BranchRecord | undefined {
  return readJson<BranchRecord>(branchFile(repoId, name));
}

export function listBranches(repoId: string): BranchRecord[] {
  return listJson<BranchRecord>(branchesDir(repoId)).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function updateBranch(
  repoId: string,
  name: string,
  patch: Partial<BranchRecord>,
): BranchRecord | undefined {
  const b = loadBranch(repoId, name);
  if (!b) return undefined;
  return saveBranch({ ...b, ...patch });
}

export function sessionFile(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

export function loadSession(sessionId: string): SessionRecord | undefined {
  return readJson<SessionRecord>(sessionFile(sessionId));
}

export function upsertSession(rec: Partial<SessionRecord> & { sessionId: string }): SessionRecord {
  const prev = loadSession(rec.sessionId);
  const next = { role: 'fork', ...prev, ...rec } as SessionRecord;
  writeJsonAtomic(sessionFile(rec.sessionId), next);
  return next;
}

export function branchForSession(sessionId: string): BranchRecord | undefined {
  const s = loadSession(sessionId);
  if (!s?.repoId || !s.branch) return undefined;
  return loadBranch(s.repoId, s.branch);
}

/** Lowest port slot (1, 2, …) not used by a live fork in this repo. Slot 0 is main. */
export function nextPortSlot(branches: BranchRecord[]): number {
  const used = new Set(
    branches.filter((b) => LIVE_STATES.includes(b.state)).map((b) => b.portSlot),
  );
  let slot = 1;
  while (used.has(slot)) slot++;
  return slot;
}

/** Pick an unused branch name: the slug itself, then slug-2, slug-3, … */
export function uniqueName(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) return slug;
  for (let i = 2; ; i++) if (!taken.has(`${slug}-${i}`)) return `${slug}-${i}`;
}
