import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeFileAtomic } from '../core/store.js';

/** One line of a Claude Code transcript (.jsonl). Only the fields pitstop relies on are typed. */
export interface TranscriptRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

interface ContentBlock {
  type?: string;
  id?: string;
  tool_use_id?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/**
 * Read a transcript that another process may still be appending to.
 *
 * The file is opened read-only, its size is taken once, and only bytes
 * 0..size are read. A last line without a trailing newline is half-written
 * and dropped. The writer is never blocked, locked or disturbed.
 */
export function readTranscriptSnapshot(file: string): TranscriptRecord[] {
  const fd = fs.openSync(file, 'r');
  let buf: Buffer;
  try {
    const size = fs.fstatSync(fd).size;
    buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    buf = buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
  return parseTranscript(buf.toString('utf8'));
}

export function parseTranscript(text: string): TranscriptRecord[] {
  const lines = text.split('\n');
  if (!text.endsWith('\n')) lines.pop(); // torn last line
  const records: TranscriptRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object') records.push(value as TranscriptRecord);
    } catch {
      // skip unparseable lines
    }
  }
  return records;
}

function blocks(r: TranscriptRecord): ContentBlock[] {
  const c = r.message?.content;
  return Array.isArray(c) ? (c as ContentBlock[]) : [];
}

const isTurn = (r: TranscriptRecord) =>
  (r.type === 'user' || r.type === 'assistant') && !r.isSidechain && typeof r.uuid === 'string';

/** The conversation the session is actually on: newest main-thread message back to the root. */
export function activeChain(records: TranscriptRecord[]): TranscriptRecord[] {
  const byUuid = new Map<string, TranscriptRecord>();
  for (const r of records) if (typeof r.uuid === 'string') byUuid.set(r.uuid, r);
  let leaf: TranscriptRecord | undefined;
  for (const r of records) if (isTurn(r)) leaf = r;
  const chain: TranscriptRecord[] = [];
  const seen = new Set<string>();
  for (let cur = leaf; cur && cur.uuid && !seen.has(cur.uuid); ) {
    seen.add(cur.uuid);
    chain.push(cur);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  return chain.reverse();
}

/** tool_use ids on the chain that have no matching tool_result yet. */
export function danglingToolUses(chain: TranscriptRecord[]): ContentBlock[] {
  const uses = new Map<string, ContentBlock>();
  const answered = new Set<string>();
  for (const r of chain) {
    for (const b of blocks(r)) {
      if (b.type === 'tool_use' && b.id) uses.set(b.id, b);
      if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
    }
  }
  return [...uses.values()].filter((b) => b.id && !answered.has(b.id));
}

export interface SealResult {
  records: TranscriptRecord[];
  /** Tool calls that were still running in the parent when it was copied. */
  pending: { id: string; name?: string; summary: string }[];
  /** True when the parent was mid-turn (pending tools, or a prompt not yet answered). */
  parentWasMidTurn: boolean;
}

export const SEAL_TOOL_RESULT =
  "[pitstop] This call was still running in the parent session when this fork was made. It is the parent's job, not yours. Do not retry it.";

export const SEAL_ASSISTANT_TEXT =
  'Forked by pitstop. The parent session keeps its in-flight work; I will wait for my own task.';

function summarize(b: ContentBlock): string {
  const input = b.input as Record<string, unknown> | undefined;
  const detail = input?.command ?? input?.file_path ?? input?.description ?? '';
  return `${b.name ?? 'tool'}${detail ? ` ${String(detail).slice(0, 80)}` : ''}`;
}

/**
 * Copy the active chain under a new session id and make it safe to resume:
 * every pending tool call gets an error result that says it belongs to the
 * parent, and the copy ends on a finished assistant turn, so the fork does
 * not pick the parent's work back up (a native fork re-runs it; see docs/spike.md).
 */
export function sealTranscript(
  records: TranscriptRecord[],
  newSessionId: string,
  now = new Date(),
): SealResult {
  const chain = activeChain(records);
  const keep = new Set(chain.map((r) => r.uuid));
  const out = records
    .filter((r) => typeof r.uuid === 'string' && keep.has(r.uuid))
    .map((r): TranscriptRecord => ({ ...r, sessionId: newSessionId }));
  const dangling = danglingToolUses(chain);
  const last = out[out.length - 1];
  const pending = dangling.map((b) => ({ id: b.id!, name: b.name, summary: summarize(b) }));
  if (!last) return { records: out, pending, parentWasMidTurn: false };

  const base: TranscriptRecord = {};
  for (const k of ['cwd', 'version', 'gitBranch', 'userType', 'entrypoint']) {
    if (last[k] !== undefined) base[k] = last[k];
  }
  const timestamp = now.toISOString();
  let parent = last.uuid!;
  if (dangling.length) {
    const uuid = crypto.randomUUID();
    out.push({
      ...base,
      type: 'user',
      uuid,
      parentUuid: parent,
      isSidechain: false,
      sessionId: newSessionId,
      timestamp,
      message: {
        role: 'user',
        content: dangling.map((b) => ({
          type: 'tool_result',
          tool_use_id: b.id,
          is_error: true,
          content: SEAL_TOOL_RESULT,
        })),
      },
    });
    parent = uuid;
  }
  const lastIsFinishedAssistant =
    last.type === 'assistant' && !blocks(last).some((b) => b.type === 'tool_use');
  const parentWasMidTurn = dangling.length > 0 || !lastIsFinishedAssistant;
  if (parentWasMidTurn) {
    const uuid = crypto.randomUUID();
    out.push({
      ...base,
      type: 'assistant',
      uuid,
      parentUuid: parent,
      isSidechain: false,
      sessionId: newSessionId,
      timestamp,
      message: {
        id: `msg_pitstop_${uuid.slice(0, 8)}`,
        type: 'message',
        role: 'assistant',
        model: '<synthetic>',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: SEAL_ASSISTANT_TEXT }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  return { records: out, pending, parentWasMidTurn };
}

export function writeTranscript(file: string, records: TranscriptRecord[]): void {
  writeFileAtomic(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 0o600);
}

/** Last assistant text on the active chain, for status lines and handoff summaries. */
export function lastAssistantText(records: TranscriptRecord[]): string | undefined {
  const chain = activeChain(records);
  for (let i = chain.length - 1; i >= 0; i--) {
    const r = chain[i]!;
    if (r.type !== 'assistant') continue;
    const text = blocks(r)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join(' ')
      .trim();
    if (text) return text;
  }
  return undefined;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model?: string;
}

/** Sum token usage across assistant messages (each message.id counted once). */
export function sumUsage(records: TranscriptRecord[]): Usage {
  const seen = new Set<string>();
  const u: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const r of records) {
    if (r.type !== 'assistant' || !r.message) continue;
    const id = (r.message.id as string | undefined) ?? r.uuid;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const usage = r.message.usage as Record<string, number> | undefined;
    if (!usage) continue;
    u.inputTokens += usage.input_tokens ?? 0;
    u.outputTokens += usage.output_tokens ?? 0;
    u.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    u.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    const model = r.message.model as string | undefined;
    if (model && model !== '<synthetic>') u.model = model;
  }
  return u;
}

/** Rough $/Mtok by model family (input, output). Shown as an estimate only. */
const PRICES: [RegExp, number, number][] = [
  [/opus/i, 15, 75],
  [/fable/i, 15, 75],
  [/haiku/i, 1, 5],
  [/sonnet/i, 3, 15],
];

export function estimateCostUsd(u: Usage): number {
  const [, inP, outP] = PRICES.find(([re]) => u.model && re.test(u.model)) ?? [/./, 3, 15];
  return (
    (u.inputTokens * inP + u.outputTokens * outP + u.cacheReadTokens * inP * 0.1 + u.cacheWriteTokens * inP * 1.25) /
    1_000_000
  );
}
