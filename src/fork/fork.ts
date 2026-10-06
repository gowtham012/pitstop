import crypto from 'node:crypto';
import path from 'node:path';
import {
  branchForSession,
  listBranches,
  LIVE_STATES,
  loadSession,
  nextPortSlot,
  saveBranch,
  uniqueName,
  upsertSession,
  type BranchRecord,
} from '../branches.js';
import { isBusy, listAgentsAsync, startBackground, type AgentInfo } from '../claude/agents.js';
import { findTranscript } from '../claude/locate.js';
import { sessionSettings } from '../claude/settings.js';
import { readTranscriptSnapshot, sealTranscript, writeTranscript } from '../claude/transcript.js';
import { loadConfig } from '../core/config.js';
import { branchExists, repoContext } from '../core/git.js';
import { branchesDir, slugify } from '../core/paths.js';
import { dropSnapshotRef, snapshotWorkingTree } from '../core/snapshot.js';
import { claimName, releaseName } from '../core/store.js';
import { forkPrompt } from './prompt.js';

export class ForkError extends Error {}

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
}

export function forkSessionName(repoName: string, name: string): string {
  return `${slugify(repoName, 20)}-${name}`;
}

/**
 * Fork a running session into a new background session with the full
 * conversation, its own port slot and (on first edit) its own worktree built
 * from a snapshot of the parent's uncommitted work.
 */
export async function forkSession(req: ForkRequest): Promise<BranchRecord> {
  const ctx = repoContext(req.cwd);
  const cfg = loadConfig(ctx.top);
  const agents = await listAgentsAsync();
  const parent: AgentInfo | undefined = agents.find((a) => a.sessionId === req.parentSessionId);
  const branches = listBranches(ctx.repoId);
  const live = branches.filter((b) => LIVE_STATES.includes(b.state) && b.state !== 'deferred');
  if (live.length + 1 >= cfg.maxSessions) {
    throw new ForkError(
      `Already running ${live.length + 1} sessions (limit ${cfg.maxSessions}). Merge or discard a fork, or raise maxSessions in .pitstop.json.`,
    );
  }
  const preset = req.preset ? cfg.presets[req.preset] : undefined;
  if (req.preset && !preset) throw new ForkError(`Unknown preset "${req.preset}"`);

  const parentBranch = branchForSession(req.parentSessionId);
  const parentRecord = loadSession(req.parentSessionId);
  // Where the parent is editing: its own worktree for a fork, else the main checkout.
  const parentDir = parentBranch?.worktree ?? ctx.top;
  const parentName = parentBranch?.sessionName ?? parentRecord?.name ?? parent?.name ?? 'main';

  const taken = new Set(branches.map((b) => b.name));
  const slug = slugify(req.name ?? req.task);
  let name = uniqueName(slug, taken);
  while (branchExists(ctx.top, `pit/${name}`) || !claimName(path.join(branchesDir(ctx.repoId), '.names'), name)) {
    taken.add(name);
    name = uniqueName(slug, taken);
  }

  const snap = snapshotWorkingTree(parentDir, name);
  const portSlot = nextPortSlot(branches);
  const now = new Date().toISOString();
  let branch: BranchRecord = saveBranch({
    name,
    repoId: ctx.repoId,
    repoTop: ctx.top,
    task: req.task,
    preset: req.preset,
    mode: req.mode,
    parentSessionId: req.parentSessionId,
    parentSessionName: parentName,
    parentBranch: parentBranch?.name,
    sessionName: forkSessionName(ctx.name, name),
    forkMethod: 'native',
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

  try {
    const transcript = findTranscript(req.parentSessionId);
    const method = req.method ?? 'auto';
    const sealed = method === 'sealed' || (method === 'auto' && isBusy(parent) && !!transcript);
    // A resumed session is looked up by the directory it was started in.
    const launchCwd = parentRecord?.cwd ?? parentDir;
    let resumeId = req.parentSessionId;
    let pending: string[] | undefined;
    if (sealed) {
      if (!transcript) throw new ForkError(`Can't find the transcript of ${req.parentSessionId}`);
      const newId = crypto.randomUUID();
      const result = sealTranscript(readTranscriptSnapshot(transcript), newId);
      writeTranscript(path.join(path.dirname(transcript), `${newId}.jsonl`), result.records);
      resumeId = newId;
      pending = result.pending.map((p) => p.summary);
    }
    const settings = sessionSettings({
      role: 'fork',
      env: {
        PITSTOP_BRANCH: name,
        PITSTOP_PARENT_SESSION: req.parentSessionId,
        PITSTOP_PORT_OFFSET: String(branch.portOffset),
      },
    });
    const launched = await startBackground({
      cwd: launchCwd,
      name: branch.sessionName,
      resume: resumeId,
      continueSession: sealed,
      settings,
      model: preset?.model,
      effort: preset?.effort,
      permissionMode: preset?.permissionMode,
      prompt: forkPrompt({
        name,
        task: req.task,
        parentSessionId: req.parentSessionId,
        parentName,
        repoTop: parentDir,
        portOffset: branch.portOffset,
        mergeMode: cfg.merge.mode,
        pending,
      }),
    });
    upsertSession({ sessionId: launched.sessionId, role: 'fork', repoId: ctx.repoId, branch: name, name: launched.name });
    branch = saveBranch({
      ...branch,
      sessionId: launched.sessionId,
      shortId: launched.shortId,
      forkMethod: sealed ? 'sealed' : 'native',
      pendingAtFork: pending,
      state: 'running',
    });
    return branch;
  } catch (err) {
    dropSnapshotRef(ctx.top, snap.ref);
    releaseName(path.join(branchesDir(ctx.repoId), '.names'), name);
    saveBranch({ ...branch, state: 'failed', note: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
