import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pitstopHome } from '../core/paths.js';

/** Command Claude Code runs for pitstop's hooks. */
export function hookCommand(): string {
  if (process.env.PITSTOP_HOOK_CMD) return process.env.PITSTOP_HOOK_CMD;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bundled: dist/cli.js sits next to dist/hook.js. From source: src/claude → dist/hook.js.
  const candidates = [path.join(here, 'hook.js'), path.resolve(here, '../../dist/hook.js')];
  const hook = candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!;
  return `"${process.execPath}" "${hook}"`;
}

export interface SessionSettingsOptions {
  role: 'main' | 'fork';
  env?: Record<string, string>;
  /** Extra permission allow rules, e.g. for the test command. */
  allow?: string[];
}

/**
 * The --settings value pitstop passes to every session it starts. Hooks
 * travel per session, so pitstop never edits the user's global settings
 * (hooks in --settings run in background sessions; see docs/spike.md).
 */
export function sessionSettings(opts: SessionSettingsOptions): Record<string, unknown> {
  const cmd = hookCommand();
  const hook = (event: string) => [
    { hooks: [{ type: 'command', command: `${cmd} ${event}`, timeout: 30 }] },
  ];
  const hooks: Record<string, unknown> = {
    SessionStart: hook('SessionStart'),
    UserPromptSubmit: hook('UserPromptSubmit'),
    PostToolUse: hook('PostToolUse'),
    SessionEnd: hook('SessionEnd'),
  };
  const settings: Record<string, unknown> = {
    hooks,
    crossSessionInbound: 'accept',
    env: { PITSTOP_HOME: pitstopHome(), ...opts.env },
  };
  if (opts.role === 'main') {
    // The main session keeps editing the user's checkout; only forks are isolated.
    settings.worktree = { bgIsolation: 'none' };
  } else {
    hooks.WorktreeCreate = hook('WorktreeCreate');
    hooks.PreToolUse = [
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
        hooks: [{ type: 'command', command: `${cmd} PreToolUse`, timeout: 30 }],
      },
    ];
  }
  if (opts.allow?.length) settings.permissions = { allow: opts.allow };
  return settings;
}
