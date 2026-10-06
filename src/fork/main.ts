import { upsertSession, type SessionRecord } from '../branches.js';
import {
  ClaudeError,
  findAgent,
  listAgentsAsync,
  startBackground,
  type AgentInfo,
} from '../claude/agents.js';
import { latestConversation } from '../claude/locate.js';
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
  /** A stopped main was continued from its latest conversation. */
  resumed?: boolean;
  /** Resuming was tried and failed, so a fresh main was started. */
  resumeError?: string;
}

/**
 * Reuse this repo's live pitstop main session, or start one as a native
 * background session (so it survives `pit` quitting) that keeps editing
 * the user's checkout.
 */
export async function ensureMainSession(
  cwd: string,
  claudeArgs: string[] = [],
  prompt?: string,
  opts: { fresh?: boolean } = {},
): Promise<MainSession> {
  const ctx = repoContext(cwd);
  const agents = await listAgentsAsync();
  const known = listJson<SessionRecord>(sessionsDir()).filter(
    (s) => s.role === 'main' && s.repoId === ctx.repoId,
  );
  const record = known.find((s) => findAgent(agents, s.sessionId));
  const existing = record && findAgent(agents, record.sessionId);
  if (record && existing && !prompt && !claudeArgs.length) {
    return {
      sessionId: record.sessionId,
      shortId: existing.id,
      name: existing.name ?? mainSessionName(ctx.name),
      reused: true,
    };
  }
  const name = mainSessionName(ctx.name);
  // Main stopped (a reboot, a crash): continue its latest conversation instead of starting over.
  let resumeError: string | undefined;
  const previous =
    opts.fresh || prompt ? undefined : latestConversation(known.map((s) => s.sessionId));
  if (previous) {
    const rec = known.find((s) => s.sessionId === previous);
    try {
      // With no flags Claude Code wakes the session with its saved options. Flags of the
      // user's own (pit --model …) start a copy with the full history and those flags.
      const launched = await startBackground({
        cwd: rec?.cwd ?? cwd,
        name,
        resume: previous,
        wake: !claudeArgs.length,
        continueSession: true,
        settings: sessionSettings({ role: 'main' }),
        extraArgs: claudeArgs,
      });
      upsertSession({
        sessionId: launched.sessionId,
        role: 'main',
        repoId: ctx.repoId,
        name: launched.name,
        cwd: rec?.cwd ?? cwd,
      });
      return {
        sessionId: launched.sessionId,
        shortId: launched.shortId,
        name: launched.name,
        reused: false,
        resumed: true,
      };
    } catch (err) {
      if (!(err instanceof ClaudeError)) throw err;
      resumeError = err.message.split('\n')[0];
    }
  }
  const launched = await startBackground({
    cwd,
    name,
    settings: sessionSettings({ role: 'main' }),
    extraArgs: claudeArgs,
    prompt,
  });
  upsertSession({
    sessionId: launched.sessionId,
    role: 'main',
    repoId: ctx.repoId,
    name: launched.name,
    cwd,
  });
  return {
    sessionId: launched.sessionId,
    shortId: launched.shortId,
    name: launched.name,
    reused: false,
    resumeError,
  };
}

/** This repo's main: the running session, if any, and its latest conversation to continue. */
export async function mainStatus(cwd: string): Promise<{ running?: AgentInfo; previous?: string }> {
  const ctx = repoContext(cwd);
  const agents = await listAgentsAsync();
  const known = listJson<SessionRecord>(sessionsDir()).filter(
    (s) => s.role === 'main' && s.repoId === ctx.repoId,
  );
  const record = known.find((s) => findAgent(agents, s.sessionId));
  return {
    running: record && findAgent(agents, record.sessionId),
    previous: latestConversation(known.map((s) => s.sessionId)),
  };
}

/** Adopt an already-running session (e.g. one started with plain `claude`) as this repo's main. */
export function adoptMainSession(cwd: string, agent: AgentInfo): MainSession {
  const ctx = repoContext(cwd);
  upsertSession({
    sessionId: agent.sessionId,
    role: 'main',
    repoId: ctx.repoId,
    name: agent.name,
    cwd: agent.cwd,
  });
  return {
    sessionId: agent.sessionId,
    shortId: agent.id,
    name: agent.name ?? 'main',
    reused: true,
  };
}
