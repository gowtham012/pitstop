import { run } from '../core/exec.js';

export interface GateResult {
  ok: boolean;
  code: number;
  /** Last lines of combined output, for showing why the gate failed. */
  tail: string;
  durationMs: number;
}

/** Run the project's test command in the fork's worktree on the fork's own port slot. */
export async function runTestGate(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 30 * 60_000,
): Promise<GateResult> {
  const start = Date.now();
  const res = await run(
    process.platform === 'win32' ? 'cmd' : 'sh',
    [process.platform === 'win32' ? '/c' : '-c', command],
    {
      cwd,
      env: { ...process.env, ...env, CI: process.env.CI ?? '1' },
      timeoutMs,
    },
  );
  const out = `${res.stdout}\n${res.stderr}`.trimEnd().split('\n');
  return {
    ok: res.code === 0,
    code: res.code,
    tail: out.slice(-40).join('\n'),
    durationMs: Date.now() - start,
  };
}
