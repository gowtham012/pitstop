import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inboxDir } from './core/paths.js';
import { writeJsonAtomic } from './core/store.js';

export type InboxKind = 'merged' | 'applied' | 'deferred' | 'radar' | 'note' | 'bg-done' | 'pull';

export interface InboxMessage {
  id: string;
  to: string;
  from: string;
  kind: InboxKind;
  text: string;
  files?: string[];
  createdAt: string;
}

export function sendInbox(msg: Omit<InboxMessage, 'id' | 'createdAt'>): InboxMessage {
  const full: InboxMessage = { ...msg, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const file = path.join(inboxDir(msg.to), `${Date.now()}-${full.id}.json`);
  writeJsonAtomic(file, full);
  return full;
}

/**
 * Take every waiting message for a session. Each file is claimed with an
 * atomic rename first, so two hooks racing on the same inbox never deliver
 * a message twice.
 */
export function claimInbox(sessionId: string): InboxMessage[] {
  const dir = inboxDir(sessionId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no inbox: the common, cheap case
  }
  const out: InboxMessage[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const src = path.join(dir, name);
    const claimed = `${src}.claimed-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      fs.renameSync(src, claimed);
    } catch {
      continue; // another hook got it
    }
    try {
      out.push(JSON.parse(fs.readFileSync(claimed, 'utf8')) as InboxMessage);
    } catch {
      // corrupt message: drop it
    }
    fs.rmSync(claimed, { force: true });
  }
  return out;
}

export function formatInbox(msgs: InboxMessage[]): string {
  return msgs
    .map((m) => {
      const files = m.files?.length ? `\nFiles: ${m.files.join(', ')}` : '';
      return `<pitstop-update from="${m.from}" kind="${m.kind}">\n${m.text}${files}\n</pitstop-update>`;
    })
    .join('\n\n');
}
