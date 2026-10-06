import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSession } from '../branches.js';

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
