import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSession } from '../branches.js';
import { isInside } from '../core/paths.js';

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/** Find a session's transcript: from pitstop's session index, else by scanning ~/.claude/projects. */
export function findTranscript(sessionId: string): string | undefined {
  const known = loadSession(sessionId)?.transcriptPath;
  if (known && fs.existsSync(known)) return known;
  const projects = path.join(claudeConfigDir(), 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const file = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

/**
 * Delete a session's conversation: `<id>.jsonl` and the `<id>/` folder beside it.
 * Only files named after this session id inside Claude's projects folder are touched.
 * Returns the paths removed.
 */
export function deleteTranscript(sessionId: string): string[] {
  const file = findTranscript(sessionId);
  if (!file) return [];
  const projects = path.join(claudeConfigDir(), 'projects');
  if (!isInside(file, projects) || path.basename(file) !== `${sessionId}.jsonl`) {
    throw new Error(`Refusing to delete ${file}: not a conversation in ${projects}`);
  }
  const removed: string[] = [];
  for (const p of [file, path.join(path.dirname(file), sessionId)]) {
    if (!fs.existsSync(p)) continue;
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(p);
  }
  return removed;
}
