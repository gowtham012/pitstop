import { activeChain, type TranscriptRecord } from './transcript.js';

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface DigestOptions {
  /** Upper bound on the digest's length. The oldest turns are dropped first. */
  maxChars?: number;
  /** Name of the session being summarized, for the header. */
  sessionName?: string;
}

function toolLine(b: Block): string {
  const input = b.input ?? {};
  const detail =
    input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? '';
  const text = String(detail).replace(/\s+/g, ' ').trim();
  return `[ran ${b.name ?? 'tool'}${text ? `: ${text.slice(0, 160)}` : ''}]`;
}

/** One readable line block per turn: "User: …", "Claude: …", "[ran Bash: …]". */
export function digestTurns(records: TranscriptRecord[]): string[] {
  const turns: string[] = [];
  for (const r of activeChain(records)) {
    const content = r.message?.content;
    if (r.type === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) turns.push(`User: ${content.trim()}`);
        continue;
      }
      // Tool results and attachments are left out; the user's own words are kept.
      const text = (Array.isArray(content) ? (content as Block[]) : [])
        .filter((b) => b.type === 'text' && b.text?.trim())
        .map((b) => b.text!.trim())
        .join('\n');
      if (text) turns.push(`User: ${text}`);
    } else if (r.type === 'assistant' && Array.isArray(content)) {
      const parts: string[] = [];
      for (const b of content as Block[]) {
        if (b.type === 'text' && b.text?.trim()) parts.push(b.text.trim());
        else if (b.type === 'tool_use') parts.push(toolLine(b));
      }
      if (parts.length) turns.push(`Claude: ${parts.join('\n')}`);
    }
  }
  return turns;
}

/**
 * A condensed, plain-text version of a Claude Code conversation for agents
 * that can't load the transcript itself (a cloud session, Codex, Gemini CLI).
 * Keeps what people said and what was done, drops tool output, and trims
 * the oldest turns first so the most recent context always fits.
 */
export function conversationDigest(records: TranscriptRecord[], opts: DigestOptions = {}): string {
  const max = opts.maxChars ?? 12_000;
  const header = `Summary of the Claude Code session${opts.sessionName ? ` "${opts.sessionName}"` : ''} you are continuing. Tool output is left out; the most recent turns are last.`;
  const turns = digestTurns(records);
  const kept: string[] = [];
  let size = header.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    let t = turns[i]!;
    if (t.length > 3000) t = `${t.slice(0, 3000)} …`;
    if (size + t.length + 2 > max) break;
    kept.unshift(t);
    size += t.length + 2;
  }
  const dropped = turns.length - kept.length;
  const note =
    dropped > 0 ? `(${dropped} earlier turn${dropped === 1 ? '' : 's'} left out)\n\n` : '';
  return `${header}\n\n${note}${kept.join('\n\n')}`;
}
