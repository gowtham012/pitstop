import { upsertSession, type SessionRecord } from '../branches.js';
import { listAgentsAsync, startBackground, type AgentInfo } from '../claude/agents.js';
import { sessionSettings } from '../claude/settings.js';
import { repoContext } from '../core/git.js';
import { sessionsDir, slugify } from '../core/paths.js';
import { listJson } from '../core/store.js';

export function mainSessionName(repoName: string): string {
  return `${slugify(repoName, 20)}-main`;
}

export interface MainSession {
  sessionId: string;
  shortId?: string;
  name: string;
  reused: boolean;
}

/**
 * Reuse this repo's live pitstop main session, or start one as a native
 * background session (so it survives `pit` quitting) that keeps editing
 * the user's checkout.
 */
export async function ensureMainSession(cwd: string, claudeArgs: string[] = [], prompt?: string): Promise<MainSession> {
  const ctx = repoContext(cwd);
  const agents = await listAgentsAsync();
  const known = listJson<SessionRecord>(sessionsDir()).filter((s) => s.role === 'main' && s.repoId === ctx.repoId);
  const alive = known
    .map((s) => agents.find((a: AgentInfo) => a.sessionId === s.sessionId))
    .filter((a): a is AgentInfo => !!a);
  const existing = alive[0];
  if (existing && !prompt && !claudeArgs.length) {
    return { sessionId: existing.sessionId, shortId: existing.id, name: existing.name ?? mainSessionName(ctx.name), reused: true };
  }
  const name = mainSessionName(ctx.name);
  const launched = await startBackground({
    cwd,
    name,
    settings: sessionSettings({ role: 'main' }),
    extraArgs: claudeArgs,
    prompt,
  });
  upsertSession({ sessionId: launched.sessionId, role: 'main', repoId: ctx.repoId, name: launched.name, cwd });
  return { sessionId: launched.sessionId, shortId: launched.shortId, name: launched.name, reused: false };
}

/** Adopt an already-running session (e.g. one started with plain `claude`) as this repo's main. */
export function adoptMainSession(cwd: string, agent: AgentInfo): MainSession {
  const ctx = repoContext(cwd);
  upsertSession({ sessionId: agent.sessionId, role: 'main', repoId: ctx.repoId, name: agent.name, cwd: agent.cwd });
  return { sessionId: agent.sessionId, shortId: agent.id, name: agent.name ?? 'main', reused: true };
}
