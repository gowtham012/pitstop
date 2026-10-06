#!/usr/bin/env node
// Stand-in for another coding agent (Codex, Gemini CLI) in tests. Logs its
// argv and cwd to $FAKE_CLAUDE_STATE/agent-calls.jsonl, optionally writes a
// file (FAKE_AGENT_WRITE=name:content), then waits like an interactive TUI.
import fs from 'node:fs';
import path from 'node:path';

const stateDir = process.env.FAKE_CLAUDE_STATE ?? process.cwd();
const argv = process.argv.slice(2);
fs.appendFileSync(
  path.join(stateDir, 'agent-calls.jsonl'),
  JSON.stringify({ argv, cwd: process.cwd(), branch: process.env.PITSTOP_BRANCH }) + '\n',
);
if (process.env.FAKE_AGENT_WRITE) {
  const [file, ...rest] = process.env.FAKE_AGENT_WRITE.split(':');
  fs.writeFileSync(path.join(process.cwd(), file), rest.join(':') + '\n');
}
const resumed = argv[0] === 'resume' || argv.includes('--resume');
process.stdout.write(
  `\x1b[2J\x1b[Hfake agent ${resumed ? 'resumed' : 'started'} in ${path.basename(process.cwd())}\r\n> `,
);
process.stdin.setRawMode?.(true);
process.stdin.on('data', (d) => {
  if (d.toString().includes('\x04')) process.exit(0);
  process.stdout.write(d.toString().replace(/\r/g, '\r\n> '));
});
setInterval(() => {}, 1000);
