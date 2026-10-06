#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Keeps its session list in
// $FAKE_CLAUDE_STATE/agents.json and appends each invocation to
// $FAKE_CLAUDE_STATE/calls.jsonl as {argv, cwd}.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const stateDir = process.env.FAKE_CLAUDE_STATE ?? path.join(process.cwd(), '.fake-claude');
fs.mkdirSync(stateDir, { recursive: true });
const agentsFile = path.join(stateDir, 'agents.json');
const argv = process.argv.slice(2);
fs.appendFileSync(
  path.join(stateDir, 'calls.jsonl'),
  JSON.stringify({ argv, cwd: process.cwd() }) + '\n',
);

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
  } catch {
    return [];
  }
};
const save = (a) => fs.writeFileSync(agentsFile, JSON.stringify(a, null, 2));
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === 'agents') {
  const all = argv.includes('--all');
  process.stdout.write(JSON.stringify(load().filter((a) => all || a.state !== 'removed')));
  process.exit(0);
}

if (argv[0] === 'stop' || argv[0] === 'rm') {
  const id = argv[1];
  const agents = load().map((a) =>
    a.id === id || a.sessionId === id
      ? { ...a, status: 'idle', state: argv[0] === 'rm' ? 'removed' : 'done' }
      : a,
  );
  save(argv[0] === 'rm' ? agents.filter((a) => a.id !== id && a.sessionId !== id) : agents);
  process.stdout.write(`${argv[0] === 'rm' ? 'removed' : 'stopped'} ${id}\n`);
  process.exit(0);
}

if (argv[0] === 'attach') {
  const id = argv[1];
  process.stdout.write(`\x1b[2J\x1b[Hfake claude session ${id}\r\n❯ `);
  process.stdin.setRawMode?.(true);
  process.stdin.on('data', (d) => {
    const s = d.toString();
    if (s.includes('\x04')) process.exit(0);
    process.stdout.write(s.replace(/\r/g, '\r\n❯ '));
  });
  setInterval(() => {}, 1000);
} else if (argv.includes('--bg')) {
  if (process.env.FAKE_CLAUDE_UNTRUSTED) {
    process.stdout.write('Workspace not trusted. Run `claude` in this folder once.\n');
    process.exit(0);
  }
  const resume = flag('--resume');
  const forkSession = argv.includes('--fork-session');
  const agents = load();
  let sessionId = crypto.randomUUID();
  if (resume && !forkSession) sessionId = resume; // continue under its own id (sealed copies)
  const id = sessionId.slice(0, 8);
  const name = flag('-n') ?? `session-${id}`;
  if (resume && forkSession && agents.some((a) => a.sessionId === resume)) {
    process.stdout.write(
      `note: session ${resume.slice(0, 8)} is already running in the background, so this started a copy as ${id}.\n`,
    );
  }
  agents.push({
    pid: process.pid,
    id,
    cwd: process.cwd(),
    kind: 'background',
    startedAt: Date.now(),
    sessionId,
    name,
    status: process.env.FAKE_CLAUDE_STATUS ?? 'idle',
    state: 'done',
  });
  save(agents);
  process.stdout.write(
    `backgrounded · ${id} · ${name}\n  claude attach ${id}    open in this terminal\n`,
  );
  process.exit(0);
} else {
  process.stdout.write(`fake-claude: unsupported ${argv.join(' ')}\n`);
  process.exit(0);
}
