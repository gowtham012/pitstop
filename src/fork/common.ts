import path from 'node:path';
import {
  branchForSession,
  listBranches,
  LIVE_STATES,
  loadSession,
  nextPortSlot,
  saveBranch,
  uniqueName,
  type BranchRecord,
  type SessionRecord,
} from '../branches.js';
import { listAgentsAsync, type AgentInfo } from '../claude/agents.js';
import { conversationDigest } from '../claude/digest.js';
import { findTranscript } from '../claude/locate.js';
import { readTranscriptSnapshot } from '../claude/transcript.js';
import { loadConfig, presetKind, type PitConfig, type Preset } from '../core/config.js';
import { branchExists, repoContext, type RepoContext } from '../core/git.js';
import { branchesDir, pitstopHome, slugify } from '../core/paths.js';
import { dropSnapshotRef, snapshotWorkingTree, type Snapshot } from '../core/snapshot.js';
import { claimName, readJson, releaseName, writeJsonAtomic } from '../core/store.js';

export class ForkError extends Error {}

/** Thrown when a fork needs the user's go-ahead first (pushing to GitHub, sending a summary to another provider). */
export class ConfirmationNeeded extends ForkError {
  constructor(
    readonly what: 'cloud' | 'agent',
    message: string,
  ) {
    super(message);
  }
}

export interface ForkRequest {
  /** Any directory inside the repository. */
  cwd: string;
  parentSessionId: string;
  task: string;
  preset?: string;
  mode: 'pane' | 'bg';
  name?: string;
  /** 'auto' (default): native when the parent is idle, sealed copy when it is mid-turn. */
  method?: 'auto' | 'native' | 'sealed';
  /** Run on another agent (a key of `agents`), overriding the preset. */
  agent?: string;
  /** Run as a Claude cloud session, overriding the preset. */
  cloud?: boolean;
  /** The user already agreed to what this fork sends elsewhere (see ConfirmationNeeded). */
  confirmed?: boolean;
}

export interface PreparedFork {
  ctx: RepoContext;
  cfg: PitConfig;
  preset?: Preset;
  kind: 'claude' | 'cloud' | 'agent';
  parent?: AgentInfo;
  parentBranch?: BranchRecord;
  parentRecord?: SessionRecord;
  /** Where the parent is editing: its own worktree for a fork, else the main checkout. */
  parentDir: string;
  parentName: string;
  snap: Snapshot;
  branch: BranchRecord;
}

export function forkSessionName(repoName: string, name: string): string {
  return `${slugify(repoName, 20)}-${name}`;
}

/** Which kind of fork a request asks for: explicit flags win over the preset. */
export function requestKind(req: ForkRequest, cfg: PitConfig): 'claude' | 'cloud' | 'agent' {
  if (req.cloud) return 'cloud';
  if (req.agent) return 'agent';
  return presetKind(req.preset ? cfg.presets[req.preset] : undefined);
}

/**
 * Everything every kind of fork shares: the session cap, a unique name,
 * a snapshot of the parent's uncommitted work, a port slot, and the branch
 * record in state 'starting'.
 */
export async function prepareFork(req: ForkRequest): Promise<PreparedFork> {
  const ctx = repoContext(req.cwd);
  const cfg = loadConfig(ctx.top);
  const parent = (await listAgentsAsync()).find((a) => a.sessionId === req.parentSessionId);
  const branches = listBranches(ctx.repoId);
  const live = branches.filter((b) => LIVE_STATES.includes(b.state) && b.state !== 'deferred');
  if (live.length + 1 >= cfg.maxSessions) {
    throw new ForkError(
      `Already running ${live.length + 1} sessions (limit ${cfg.maxSessions}). Merge or delete a fork, or raise maxSessions in .pitstop.json.`,
    );
  }
  const preset = req.preset ? cfg.presets[req.preset] : undefined;
  if (req.preset && !preset) throw new ForkError(`Unknown preset "${req.preset}"`);
  const kind = requestKind(req, cfg);
  const agent = req.agent ?? preset?.agent;
  if (kind === 'agent' && (!agent || !cfg.agents[agent])) {
    throw new ForkError(
      `Unknown agent "${agent ?? ''}". Known agents: ${Object.keys(cfg.agents).join(', ') || 'none'}.`,
    );
  }

  const parentBranch = branchForSession(req.parentSessionId);
  const parentRecord = loadSession(req.parentSessionId);
  const parentDir = parentBranch?.worktree ?? ctx.top;
  const parentName = parentBranch?.sessionName ?? parentRecord?.name ?? parent?.name ?? 'main';

  const taken = new Set(branches.map((b) => b.name));
  const slug = slugify(req.name ?? req.task);
  let name = uniqueName(slug, taken);
  while (
    branchExists(ctx.top, `pit/${name}`) ||
    !claimName(path.join(branchesDir(ctx.repoId), '.names'), name)
  ) {
    taken.add(name);
    name = uniqueName(slug, taken);
  }

  const snap = snapshotWorkingTree(parentDir, name);
  const portSlot = nextPortSlot(branches);
  const now = new Date().toISOString();
  const branch = saveBranch({
    name,
    repoId: ctx.repoId,
    repoTop: ctx.top,
    task: req.task,
    preset: req.preset,
    mode: kind === 'claude' ? req.mode : 'pane',
    kind,
    agent: kind === 'agent' ? agent : undefined,
    parentSessionId: req.parentSessionId,
    parentSessionName: parentName,
    parentBranch: parentBranch?.name,
    sessionName: forkSessionName(ctx.name, name),
    forkMethod: kind === 'claude' ? 'native' : 'summary',
    snapshotCommit: snap.commit,
    snapshotRef: snap.ref,
    baseCommit: snap.base,
    gitBranch: `pit/${name}`,
    portSlot,
    portOffset: portSlot * cfg.portStep,
    state: 'starting',
    budgetUsd: preset?.budgetUsd,
    testGate: preset?.testGate ?? cfg.testGate,
    createdAt: now,
    updatedAt: now,
  });
  return {
    ctx,
    cfg,
    preset,
    kind,
    parent,
    parentBranch,
    parentRecord,
    parentDir,
    parentName,
    snap,
    branch,
  };
}

/** Undo what prepareFork claimed and record why the fork failed. */
export function abortFork(p: PreparedFork, err: unknown): never {
  dropSnapshotRef(p.ctx.top, p.snap.ref);
  releaseName(path.join(branchesDir(p.ctx.repoId), '.names'), p.branch.name);
  saveBranch({
    ...p.branch,
    state: 'failed',
    note: err instanceof Error ? err.message : String(err),
  });
  throw err;
}

/** Condensed conversation of the parent, for forks that can't load its transcript. */
export function parentDigest(p: PreparedFork, maxChars = 12_000): string {
  const transcript = findTranscript(p.branch.parentSessionId);
  if (!transcript) return `(No transcript was found for the parent session "${p.parentName}".)`;
  return conversationDigest(readTranscriptSnapshot(transcript), {
    maxChars,
    sessionName: p.parentName,
  });
}

// ---- consent ---------------------------------------------------------------

interface ConsentFile {
  agents?: Record<string, string>;
}

function consentFile(): string {
  return path.join(pitstopHome(), 'consent.json');
}

/** Whether the user already agreed to send conversation summaries from this repo to `agent`. */
export function agentConsentGiven(repoId: string, agent: string): boolean {
  return !!readJson<ConsentFile>(consentFile())?.agents?.[`${repoId}:${agent}`];
}

export function recordAgentConsent(repoId: string, agent: string): void {
  const cur = readJson<ConsentFile>(consentFile()) ?? {};
  writeJsonAtomic(consentFile(), {
    ...cur,
    agents: { ...cur.agents, [`${repoId}:${agent}`]: new Date().toISOString() },
  });
}
