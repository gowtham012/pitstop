// Manual end-to-end check against the REAL claude CLI (spends a few cents of tokens).
// Usage: npm run build && node scripts/e2e-real.mjs <path-to-a-trusted-git-repo>
import pty from 'node-pty';
import xterm from '@xterm/headless';
import fs from 'node:fs';
const [, , cwd] = process.argv;
const cols = 200,
  rows = 50;
const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
const p = pty.spawn(process.execPath, [new URL('../dist/cli.js', import.meta.url).pathname], {
  cwd,
  cols,
  rows,
  name: 'xterm-256color',
  env: process.env,
});
p.onData((d) => term.write(d));
let exited = false;
p.onExit(() => (exited = true));
const screen = () => {
  const b = term.buffer.active;
  const o = [];
  for (let i = 0; i < rows; i++) o.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
  return o.join('\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(re, ms = 60000, label = String(re)) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (re.test(screen())) {
      console.log(`[ok] ${label} (${Math.round((Date.now() - t) / 1000)}s)`);
      return true;
    }
    if (exited) break;
    await sleep(500);
  }
  console.log(`[TIMEOUT] ${label}\n${screen()}`);
  return false;
}
const dump = (t) =>
  console.log(
    `----- ${t} -----\n` +
      screen()
        .split('\n')
        .filter((l) => l.trim())
        .join('\n'),
  );
const type = async (s) => {
  for (const ch of s) {
    p.write(ch);
    await sleep(8);
  }
};

await waitFor(/1 . main/, 90000, 'main pane up');
await waitFor(/❯/, 60000, 'main prompt');
await sleep(1500);
await type('Remember the codename BLUEBIRD-42. Reply with exactly: noted');
await sleep(300);
p.write('\r');
await waitFor(/noted/, 90000, 'main replied');
await sleep(2000);
p.write('\x1c');
await sleep(200);
p.write('f');
await waitFor(/task \(/, 10000, 'fork prompt');
await type(
  'hotfix: Create a file named hello.txt whose only content is the codename I asked you to remember. Then git commit it.',
);
p.write('\r');
await waitFor(/forked create-a-file/, 120000, 'forked');
dump('after fork');
await waitFor(/2 . create-a-file[^\n]*idle/, 300000, 'fork finished (idle)');
await sleep(3000);
dump('fork done');
p.write('\x1c');
await sleep(200);
p.write('m');
await waitFor(/Merge create-a-file/, 15000, 'merge confirm');
p.write('y');
await waitFor(/Result:/, 120000, 'merge result');
dump('merge result');
p.write('x');
await sleep(500);
p.write('\x1c');
await sleep(200);
p.write('1');
await sleep(1000);
await type('Did you receive a pitstop-update? Reply in one sentence naming the file it mentions.');
await sleep(300);
p.write('\r');
await waitFor(/hello\.txt[\s\S]*❯/, 120000, 'main saw update');
await sleep(4000);
dump('final');
p.write('\x1c');
await sleep(200);
p.write('q');
await sleep(500);
p.write('y');
await sleep(2000);
process.exit(0);
