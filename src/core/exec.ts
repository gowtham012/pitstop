import { spawn, spawnSync } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

export function runSync(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { code: 127, stdout: '', stderr: `${cmd}: command not found` };
  }
  return {
    code: res.status ?? (res.signal ? 128 : 1),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? String(res.error) : ''),
  };
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: stderr || String(err) });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
