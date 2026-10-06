import {
  branchKind,
  loadBranch,
  saveBranch,
  upsertSession,
  type BranchRecord,
  type SessionRecord,
} from '../branches.js';
import { findAgent, listAgentsAsync, startBackground, type AgentInfo } from '../claude/agents.js';
import { latestConversation } from '../claude/locate.js';
import { repoContext } from '../core/git.js';
import { sessionsDir } from '../core/paths.js';
import { listJson } from '../core/store.js';

export class ResumeError extends Error {}

/** States in which a fork's session is supposed to exist. */
const RESUMABLE: BranchRecord['state'][] = ['starting', 'running', 'idle', 'done', 'failed'];

/** Why this fork can't be resumed, or undefined when it can. */
export function whyNotResumable(b: BranchRecord, agents: AgentInfo[]): string | undefined {
  const kind = branchKind(b);
  if (kind === 'agent')
    return `${b.name} runs ${b.agent ?? 'another agent'}; its pane resumes it when pit starts`;
  if (kind === 'cloud') return `${b.name} runs in the cloud and doesn't stop with your machine`;
  if (!RESUMABLE.includes(b.state))
    return `${b.name} is ${b.state === 'discarded' ? 'deleted' : b.state}`;
  if (!b.sessionId) return `${b.name} never started a session`;
  if (findAgent(agents, b.sessionId)) return `${b.name} is still running`;
  if (/budget/.test(b.note ?? ''))
    return `${b.name} was stopped at its $${b.budgetUsd} budget; raise budgetUsd in its preset to resume it`;
  return undefined;
}

/** Pane forks whose sessions are gone (after a reboot or a crash) and can be continued. */
export function stoppedForks(branches: BranchRecord[], agents: AgentInfo[]): BranchRecord[] {
  return branches.filter((b) => b.mode === 'pane' && !whyNotResumable(b, agents));
}

/**
 * Continue a stopped Claude fork from its latest conversation. Claude Code wakes it with
 * the options it was started with, so it keeps its hooks, environment and preset. It finds its worktree again through the
 * WorktreeCreate hook, which hands back the existing one.
 */
export async function resumeFork(cwd: string, name: string): Promise<BranchRecord> {
  const ctx = repoContext(cwd);
  const b = loadBranch(ctx.repoId, name);
  if (!b) throw new ResumeError(`No fork named "${name}"`);
  const why = whyNotResumable(b, await listAgentsAsync());
  if (why) throw new ResumeError(why);
  // Its conversation may have moved to a new id since it started; hooks record those too.
  const ids = [
    b.sessionId!,
    ...listJson<SessionRecord>(sessionsDir())
      .filter((s) => s.repoId === b.repoId && s.branch === b.name)
      .map((s) => s.sessionId),
  ];
  const conversation = latestConversation(ids);
  if (!conversation) throw new ResumeError(`Can't find the conversation of ${name}`);
  // Woken with no flags: the session keeps the hooks, environment and preset it was forked with.
  const launched = await startBackground({
    cwd: b.sessionCwd ?? b.repoTop,
    name: b.sessionName,
    resume: conversation,
    wake: true,
  });
  upsertSession({
    sessionId: launched.sessionId,
    role: 'fork',
    repoId: b.repoId,
    branch: b.name,
    name: launched.name,
  });
  return saveBranch({
    ...b,
    sessionId: launched.sessionId,
    shortId: launched.shortId,
    state: 'running',
  });
}
