import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeChain,
  danglingToolUses,
  estimateCostUsd,
  lastAssistantText,
  parseTranscript,
  readTranscriptSnapshot,
  SEAL_ASSISTANT_TEXT,
  SEAL_TOOL_RESULT,
  sealTranscript,
  sumUsage,
  type TranscriptRecord,
} from '../../src/claude/transcript.js';
import { tmpDir } from '../helpers.js';

let n = 0;
function rec(
  type: string,
  parent: string | null,
  content: unknown,
  extra: Partial<TranscriptRecord> = {},
): TranscriptRecord {
  return {
    type,
    uuid: `u${++n}`,
    parentUuid: parent,
    sessionId: 'parent',
    cwd: '/repo',
    isSidechain: false,
    message: { role: type, content },
    ...extra,
  };
}
const text = (t: string) => [{ type: 'text', text: t }];
const toolUse = (id: string, command = 'pytest') => ({
  type: 'tool_use',
  id,
  name: 'Bash',
  input: { command },
});
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });
const jsonl = (records: TranscriptRecord[]) =>
  records.map((r) => JSON.stringify(r)).join('\n') + '\n';

describe('parseTranscript', () => {
  it('drops a torn last line and unparseable lines', () => {
    const good = rec('user', null, 'hi');
    const records = parseTranscript(`${JSON.stringify(good)}\nnot json\n{"type":"assis`);
    expect(records).toHaveLength(1);
    expect(records[0]!.uuid).toBe(good.uuid);
  });

  it('reads only the bytes present when the snapshot is taken', () => {
    const dir = tmpDir();
    const file = path.join(dir, 't.jsonl');
    const a = rec('user', null, 'one');
    fs.writeFileSync(file, `${JSON.stringify(a)}\n{"partial":`);
    expect(readTranscriptSnapshot(file)).toHaveLength(1);
  });
});

describe('activeChain', () => {
  it('follows the newest main-thread leaf back to the root and skips abandoned branches', () => {
    const u1 = rec('user', null, 'task');
    const a1 = rec('assistant', u1.uuid!, text('v1'));
    const abandoned = rec('user', a1.uuid!, 'old edit');
    const u2 = rec('user', a1.uuid!, 'new edit');
    const side = rec('assistant', u2.uuid!, text('subagent'), { isSidechain: true });
    const a2 = rec('assistant', u2.uuid!, text('v2'));
    const chain = activeChain([u1, a1, abandoned, u2, side, a2]);
    expect(chain.map((r) => r.uuid)).toEqual([u1.uuid, a1.uuid, u2.uuid, a2.uuid]);
  });
});

describe('sealTranscript', () => {
  it('leaves a finished conversation as is, apart from the new session id', () => {
    const u1 = rec('user', null, 'task');
    const a1 = rec('assistant', u1.uuid!, text('done'));
    const out = sealTranscript([u1, a1], 'fork');
    expect(out.parentWasMidTurn).toBe(false);
    expect(out.pending).toEqual([]);
    expect(out.records).toHaveLength(2);
    expect(out.records.every((r) => r.sessionId === 'fork')).toBe(true);
  });

  it("answers a still-running tool call as the parent's job and ends on an assistant turn", () => {
    const u1 = rec('user', null, 'run the tests');
    const a1 = rec('assistant', u1.uuid!, [toolUse('t1', 'pytest -q')]);
    const out = sealTranscript(
      parseTranscript(jsonl([u1, a1])),
      'fork',
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(out.parentWasMidTurn).toBe(true);
    expect(out.pending).toEqual([{ id: 't1', name: 'Bash', summary: 'Bash pytest -q' }]);
    const [, , result, closing] = out.records;
    expect(result!.type).toBe('user');
    expect(result!.parentUuid).toBe(a1.uuid);
    expect(result!.message!.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', is_error: true, content: SEAL_TOOL_RESULT },
    ]);
    expect(closing!.type).toBe('assistant');
    expect(closing!.parentUuid).toBe(result!.uuid);
    expect((closing!.message as { stop_reason: string }).stop_reason).toBe('end_turn');
    expect(JSON.stringify(closing!.message!.content)).toContain(SEAL_ASSISTANT_TEXT);
    expect(danglingToolUses(activeChain(out.records))).toEqual([]);
  });

  it('only answers the parallel tool calls that are still pending', () => {
    const u1 = rec('user', null, 'go');
    const a1 = rec('assistant', u1.uuid!, [toolUse('t1'), toolUse('t2', 'npm test')]);
    const r1 = rec('user', a1.uuid!, [toolResult('t1')]);
    const out = sealTranscript([u1, a1, r1], 'fork');
    expect(out.pending.map((p) => p.id)).toEqual(['t2']);
    const added = out.records[3]!;
    expect((added.message!.content as { tool_use_id: string }[]).map((b) => b.tool_use_id)).toEqual(
      ['t2'],
    );
  });

  it('closes a prompt the parent had not answered yet', () => {
    const u1 = rec('user', null, 'task');
    const a1 = rec('assistant', u1.uuid!, text('done'));
    const u2 = rec('user', a1.uuid!, 'next thing');
    const out = sealTranscript([u1, a1, u2], 'fork');
    expect(out.parentWasMidTurn).toBe(true);
    expect(out.records.at(-1)!.type).toBe('assistant');
    expect(out.records.at(-1)!.parentUuid).toBe(u2.uuid);
  });

  it('drops sidechain records and records that are not on the active chain', () => {
    const u1 = rec('user', null, 'task');
    const side = rec('assistant', u1.uuid!, text('sub'), { isSidechain: true });
    const a1 = rec('assistant', u1.uuid!, text('done'));
    const snapshot = { type: 'file-history-snapshot', snapshot: { '/abs/path': 'x' } };
    const out = sealTranscript([u1, side, snapshot, a1], 'fork');
    expect(out.records.map((r) => r.uuid)).toEqual([u1.uuid, a1.uuid]);
  });
});

describe('usage', () => {
  it('counts each assistant message once and estimates cost', () => {
    const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0 };
    const a = rec('assistant', null, text('x'), {});
    a.message = {
      role: 'assistant',
      id: 'm1',
      model: 'claude-sonnet-5-5',
      usage,
      content: text('x'),
    };
    const b = { ...a, uuid: 'other' }; // same message id split across records
    const u = sumUsage([a, b]);
    expect(u.inputTokens).toBe(1000);
    expect(u.outputTokens).toBe(500);
    expect(estimateCostUsd(u)).toBeGreaterThan(0);
  });

  it('finds the last assistant text', () => {
    const u1 = rec('user', null, 'task');
    const a1 = rec('assistant', u1.uuid!, text('All tests pass.'));
    expect(lastAssistantText([u1, a1])).toBe('All tests pass.');
  });
});
