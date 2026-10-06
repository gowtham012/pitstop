import { saveBranch, type BranchRecord } from '../branches.js';
import {
  abortFork,
  agentConsentGiven,
  ConfirmationNeeded,
  ForkError,
  parentDigest,
  prepareFork,
  type ForkRequest,
} from './common.js';
import { summaryForkPrompt } from './prompt.js';
import { createForkWorktree } from './worktree.js';
import { loadConfig } from '../core/config.js';
import { repoContext } from '../core/git.js';
import { branchForSession } from '../branches.js';

/**
 * Fork into another coding agent (Codex, Gemini CLI, …). These agents can't
 * load a Claude transcript, so the fork starts from a summary of it. pitstop
 * builds the worktree itself (no hooks run in other agents) and records the
 * command; the pane that runs it is opened by `pit`.
 */
export async function forkAgent(req: ForkRequest): Promise<BranchRecord> {
  const ctx = repoContext(req.cwd);
  const cfg = loadConfig(ctx.top);
  const agent = req.agent ?? (req.preset ? cfg.presets[req.preset]?.agent : undefined);
  const agentCfg = agent ? cfg.agents[agent] : undefined;
  if (!agent || !agentCfg) throw new ForkError(`Unknown agent "${agent ?? ''}"`);
  const parentBranch = branchForSession(req.parentSessionId);
  if (parentBranch && (parentBranch.kind === 'agent' || parentBranch.kind === 'cloud')) {
    throw new ForkError(
      `Only Claude sessions can be forked: "${parentBranch.name}" runs ${parentBranch.agent ?? 'in the cloud'} and has no transcript to fork.`,
    );
  }
  if (!req.confirmed && !agentConsentGiven(ctx.repoId, agent)) {
    throw new ConfirmationNeeded(
      'agent',
      `This sends a summary of this Claude conversation to ${agent}${agentCfg.provider ? ` (${agentCfg.provider})` : ''}.`,
    );
  }

  const p = await prepareFork({ ...req, agent });
  try {
    const worktree = createForkWorktree(p.branch, p.cfg.setup);
    const prompt = summaryForkPrompt({
      kind: 'agent',
      name: p.branch.name,
      task: req.task,
      parentName: p.parentName,
      digest: parentDigest(p),
      gitBranch: p.branch.gitBranch,
      portOffset: p.branch.portOffset,
      mergeMode: p.cfg.merge.mode,
    });
    return saveBranch({
      ...p.branch,
      worktree,
      snapshotRef: undefined,
      launch: {
        cmd: agentCfg.cmd,
        args: [...(agentCfg.args ?? []), prompt],
        cwd: worktree,
        env: { PITSTOP_BRANCH: p.branch.name, PITSTOP_PORT_OFFSET: String(p.branch.portOffset) },
      },
      resumeArgs: agentCfg.resumeArgs,
    });
  } catch (err) {
    return abortFork(p, err);
  }
}
