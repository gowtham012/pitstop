// Spike helper: run a command in a pty, mirror its screen into a headless xterm,
// and run a scripted list of {waitFor, send} steps. Prints the final screen.
import pty from 'node-pty';
import xterm from '@xterm/headless';
const { Terminal } = xterm;

const [, , cwd, stepsJson, ...cmd] = process.argv;
const steps = JSON.parse(stepsJson);
const cols = 120, rows = 40;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const p = pty.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols, rows, cwd, env: process.env });
p.onData((d) => term.write(d));
let exited = false;
p.onExit(({ exitCode }) => { exited = true; console.log(`[exit ${exitCode}]`); });

const screen = () => {
  const b = term.buffer.active; const out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(re, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (new RegExp(re, 'i').test(screen())) return true; if (exited) return false; await sleep(200); }
  return false;
}
for (const s of steps) {
  if (s.dump) console.log("----- DUMP -----\n" + screen().split("\n").filter((l) => l.trim()).slice(-25).join("\n"));
  if (s.waitFor) { const ok = await waitFor(s.waitFor, s.ms ?? 20000); console.log(`[wait ${s.waitFor}: ${ok}]`); }
  if (s.sleep) await sleep(s.sleep);
  if (s.send) p.write(s.send.replace(/\\r/g, '\r'));
}
await sleep(500);
console.log('----- SCREEN -----\n' + screen().split('\n').filter((l) => l.trim()).slice(-35).join('\n'));
if (!exited) p.kill();
process.exit(0);
