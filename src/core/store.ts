import fs from 'node:fs';
import path from 'node:path';

/**
 * Small file-backed store. Every record is its own JSON file written with
 * tmp + fsync + rename, so readers never see a half-written record and
 * concurrent writers to different records never contend.
 */
export function writeJsonAtomic(file: string, data: unknown, mode = 0o600): void {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', mode);
}

export function writeFileAtomic(file: string, contents: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function listJson<T>(dir: string): T[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const value = readJson<T>(path.join(dir, name));
    if (value !== undefined) out.push(value);
  }
  return out;
}

export function removeFile(file: string): void {
  fs.rmSync(file, { force: true });
}

/** Atomically claim a name inside `dir`. Returns false when it is already taken. */
export function claimName(dir: string, name: string): boolean {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.mkdirSync(path.join(dir, name));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export function releaseName(dir: string, name: string): void {
  fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out waiting for lock ${lockPath}`);
  }
}

/**
 * Run `fn` while holding a directory lock. A lock older than `staleMs` is
 * treated as abandoned (its holder crashed) and taken over.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  { timeoutMs = 30_000, staleMs = 10 * 60_000, pollMs = 100 } = {},
): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner'), String(process.pid));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new LockTimeoutError(lockPath);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}
