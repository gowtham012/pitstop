import crypto from 'node:crypto';
import path from 'node:path';
import { saveBranch, upsertSession, type BranchRecord } from '../branches.js';
import { currentSessionId, isBusy, startBackground } from '../claude/agents.js';
import { findTranscript } from '../claude/locate.js';
import { sessionSettings } from '../claude/settings.js';
import { readTranscriptSnapshot, sealTranscript, writeTranscript } from '../claude/transcript.js';
import { loadConfig } from '../core/config.js';
import { repoContext } from '../core/git.js';
import { forkAgent } from './agent.js';
import { forkCloud } from './cloud.js';
import { abortFork, ForkError, prepareFork, requestKind, type ForkRequest } from './common.js';
import { forkPrompt } from './prompt.js';

export { ConfirmationNeeded, ForkError, forkSessionName, type ForkRequest } from './common.js';

/**
 * Fork a running session. Claude forks get the full conversation in a new
 * background session; cloud and agent forks get a summary of it (see
 * fork/cloud.ts and fork/agent.ts). Every fork gets its own port slot and a
 * worktree built from a snapshot of the parent's uncommitted work.
 */
export async function forkSession(req: ForkRequest): Promise<BranchRecord> {
  req = { ...req, parentSessionId: await currentSessionId(req.parentSessionId) };
  const kind = requestKind(req, loadConfig(repoContext(req.cwd).top));
  if (kind === 'cloud') return forkCloud(req);
  if (kind === 'agent') return forkAgent(req);
  return forkClaude(req);
}

async function forkClaude(req: ForkRequest): Promise<BranchRecord> {
  const p = await prepareFork(req);
  const { ctx, cfg, preset, parent, parentRecord, parentDir, parentName } = p;
  let branch = p.branch;
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
      pending = result.pending.map((x) => x.summary);
    }
    const settings = sessionSettings({
      role: 'fork',
      env: {
        PITSTOP_BRANCH: branch.name,
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
        name: branch.name,
        task: req.task,
        parentSessionId: req.parentSessionId,
        parentName,
        repoTop: parentDir,
        portOffset: branch.portOffset,
        mergeMode: cfg.merge.mode,
        pending,
      }),
    });
    upsertSession({
      sessionId: launched.sessionId,
      role: 'fork',
      repoId: ctx.repoId,
      branch: branch.name,
      name: launched.name,
    });
    branch = saveBranch({
      ...branch,
      sessionId: launched.sessionId,
      shortId: launched.shortId,
      sessionCwd: launchCwd,
      forkMethod: sealed ? 'sealed' : 'native',
      pendingAtFork: pending,
      state: 'running',
    });
    return branch;
  } catch (err) {
    return abortFork(p, err);
  }
}
