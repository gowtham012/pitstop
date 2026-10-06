import React from 'react';
import { useCurrentFrame } from 'remotion';
import { C } from '../theme';
import { BottomBar, Dot, L, Window } from './ui';

export const WIN = { left: 160, top: 150, width: 1600, height: 880 };
/** Pane area inside the window (below the title bar, above the bottom bar). */
export const AREA = { width: WIN.width, height: WIN.height - 38 - 34 };

export const PitWindow: React.FC<{
  tabs: React.ComponentProps<typeof BottomBar>['tabs'];
  message?: { text: string; color: string };
  pressed?: string;
  prompt?: string;
  style?: React.CSSProperties;
  open3d?: boolean;
  children?: React.ReactNode;
}> = ({ tabs, message, pressed, prompt, style, open3d, children }) => (
  <Window title="pit — ~/my-app" width={WIN.width} height={WIN.height} open3d={open3d} style={{ left: WIN.left, top: WIN.top, ...style }}>
    {children}
    {prompt !== undefined ? (
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 34,
          background: '#262626',
          display: 'flex',
          alignItems: 'center',
          fontSize: 17,
        }}
      >
        <span style={{ background: C.accent, color: '#000', fontWeight: 700, padding: '0 10px', height: '100%', display: 'flex', alignItems: 'center' }}>
          fork of main · no preset (Tab) · task:
        </span>
        <span style={{ color: C.text, marginLeft: 10 }}>
          {prompt}
          <span style={{ background: C.text, marginLeft: 1 }}>&nbsp;</span>
        </span>
      </div>
    ) : (
      <BottomBar tabs={tabs} message={message} pressed={pressed} />
    )}
  </Window>
);

/** Main's pane: a long test run that keeps going, whatever else happens. */
export const MainContent: React.FC<{ base?: number; extra?: React.ReactNode }> = ({ base = 0, extra }) => {
  const frame = useCurrentFrame() + base;
  const done = Math.min(239, 61 + Math.floor(frame / 9));
  const secs = 3 + Math.floor(frame / 60);
  const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(frame / 5) % 10];
  return (
    <>
      <L color={C.text}>
        <span style={{ color: C.dim }}>❯ </span>run the full integration suite and fix anything that fails
      </L>
      <L> </L>
      <L>
        <Dot />
        Running the suite now. It takes about 20 minutes.
      </L>
      <L> </L>
      <L color={C.dim}>  Bash(npm run test:integration)</L>
      <L color={C.dim}>
        {'  ⎿  '}
        <span style={{ color: C.green }}>✓</span> auth (42)  <span style={{ color: C.green }}>✓</span> billing (118)  {spin} orders{' '}
        <span style={{ color: C.text }}>{done}</span>/240
      </L>
      <L> </L>
      <L>
        <Dot />
        {160 + done} passing so far, still running orders and search.
      </L>
      <L> </L>
      <L color="#d78787">
        ✻ Testing… (14m {String(secs % 60).padStart(2, '0')}s · esc to interrupt)
      </L>
      {extra}
    </>
  );
};

/** The fork's pane: a hotfix done with main's full context. `start` is when the task was typed. */
export const ForkContent: React.FC<{ start: number; still?: boolean }> = ({ start, still }) => {
  const at = (d: number) => (still ? -100 : start + d);
  return (
    <>
      <L at={at(0)}>
        <span style={{ color: C.dim }}>❯ </span>hotfix: fix the 500 on /login
      </L>
      <L at={at(0)}> </L>
      <L at={at(30)}>
        <Dot />I have the full context from main. The 500 comes from
      </L>
      <L at={at(36)}>
        {'  '}
        <b>auth/sso.ts</b>: the callback reads profile.email before
      </L>
      <L at={at(42)}>  the null check.</L>
      <L at={at(42)}> </L>
      <L at={at(80)} color={C.dim}>
        {'  '}Update(auth/sso.ts)
      </L>
      <L at={at(92)} color={C.dim}>
        {'  ⎿  '}Added 3 lines, removed 1 line
      </L>
      <L at={at(92)}> </L>
      <L at={at(130)} color={C.dim}>
        {'  '}Bash(npm test -- auth)
      </L>
      <L at={at(150)} color={C.dim}>
        {'  ⎿  '}
        <span style={{ color: C.green }}>✓</span> 43 passed
      </L>
      <L at={at(150)}> </L>
      <L at={at(185)}>
        <Dot />
        Fixed and committed on <b>pit/fix-the-500</b>. Ready to merge.
      </L>
    </>
  );
};

export const mainSegs = (state: 'working' | 'idle', focused = false) => [
  { text: '1 main', color: focused ? '#fff' : C.blue, bold: true },
  state === 'working'
    ? { text: '● working', color: C.green }
    : { text: '○ idle', color: C.dim },
];

export const forkSegs = (name: string, state: string, color: string, focused: boolean, parent = 'fork of main', n = 2) => [
  { text: `${n} ${name}`, color: focused ? '#fff' : C.text, bold: focused },
  { text: state, color },
  { text: parent, color: C.dim },
];

/** A mouse pointer gliding to (x, y) between frames `from` and `to`, clicking at `to`. */
export const Pointer: React.FC<{ path: { f: number; x: number; y: number }[]; clicks?: number[] }> = ({ path, clicks = [] }) => {
  const frame = useCurrentFrame();
  let x = path[0]!.x;
  let y = path[0]!.y;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    if (frame >= a.f && frame <= b.f) {
      const t = (frame - a.f) / (b.f - a.f);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      x = a.x + (b.x - a.x) * e;
      y = a.y + (b.y - a.y) * e;
    } else if (frame > b.f) {
      x = b.x;
      y = b.y;
    }
  }
  const click = clicks.some((c) => frame >= c && frame < c + 8);
  const ring = clicks.map((c) => frame - c).find((d) => d >= 0 && d < 24);
  return (
    <div style={{ position: 'absolute', left: x, top: y, zIndex: 80, pointerEvents: 'none' }}>
      {ring !== undefined && (
        <div
          style={{
            position: 'absolute',
            left: -ring * 1.5,
            top: -ring * 1.5,
            width: ring * 3,
            height: ring * 3,
            borderRadius: '50%',
            border: `3px solid ${C.accent}`,
            opacity: 1 - ring / 24,
          }}
        />
      )}
      <svg width="34" height="40" viewBox="0 0 34 40" style={{ transform: `scale(${click ? 0.86 : 1})`, filter: 'drop-shadow(0 4px 8px #000a)' }}>
        <path d="M3 2 L3 32 L11 25 L17 38 L23 35 L17 22 L28 22 Z" fill="#fff" stroke="#000" strokeWidth="2.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
};
