import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

let fixed = false;

/**
 * node-pty 1.1.0 ships its macOS `spawn-helper` without the execute bit, so every
 * spawn fails with `posix_spawnp failed`. Restore the bit once before first use.
 */
export function ensureSpawnHelper(): void {
  if (fixed || process.platform !== 'darwin') return;
  fixed = true;
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    const candidates = [
      path.join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
      path.join(root, 'build', 'Release', 'spawn-helper'),
    ];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const mode = fs.statSync(file).mode;
      if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o755);
    }
  } catch {
    // Read-only install or unexpected layout: spawn will report the real error.
  }
}

export function loadPty(): typeof import('node-pty') {
  ensureSpawnHelper();
  return require('node-pty') as typeof import('node-pty');
}
