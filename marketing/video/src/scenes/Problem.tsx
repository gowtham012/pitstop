import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion';
import { Background, Caption, fadeIn, Logo, Tag, Window } from '../components/ui';
import { C, FONT } from '../theme';

type Term = {
  title: string;
  lines: { t: string; c?: string }[];
  tag?: { text: string; color: string };
  x: number;
  y: number;
  at: number;
};

/** One project, a pile of terminals: the problem pitstop solves. */
export const TERMS: Term[] = [
  {
    title: 'claude — main · running the test suite',
    lines: [
      { t: '❯ run the full integration suite', c: C.dim },
      { t: '● Running the suite. ~20 min.' },
      { t: '  ⎿  ✓ auth  ✓ billing  ⠼ orders 61/240', c: C.dim },
    ],
    tag: { text: "can't stop this one", color: C.green },
    x: 120,
    y: 190,
    at: 20,
  },
  {
    title: 'claude — new session',
    lines: [
      { t: '❯ fix the 500 on /login', c: C.dim },
      { t: "● I don't know this project yet." },
      { t: '  Could you describe the codebase?' },
    ],
    tag: { text: 'zero context', color: C.red },
    x: 760,
    y: 150,
    at: 75,
  },
  {
    title: 'zsh — my-app',
    lines: [
      { t: '$ git stash', c: C.dim },
      { t: 'Saved working directory and index state' },
      { t: 'WIP on main: 4f2a1c9 orders refactor', c: C.dim },
    ],
    tag: { text: 'half-done work stashed', color: C.yellow },
    x: 1240,
    y: 300,
    at: 125,
  },
  {
    title: 'claude — hotfix (2)',
    lines: [
      { t: '❯ as I said, auth lives in auth/sso.ts,', c: C.dim },
      { t: '  sessions are in Redis, the 500 is…', c: C.dim },
    ],
    tag: { text: 'explaining it all again', color: C.red },
    x: 300,
    y: 520,
    at: 175,
  },
  {
    title: 'zsh — npm test',
    lines: [
      { t: '$ npm test', c: C.dim },
      { t: 'Error: listen EADDRINUSE :::3000', c: C.red },
    ],
    tag: { text: 'port clash', color: C.red },
    x: 980,
    y: 600,
    at: 220,
  },
  {
    title: 'claude — ???',
    lines: [
      { t: '❯ wait, which window had the fix?', c: C.dim },
    ],
    tag: { text: 'which one was it?', color: C.yellow },
    x: 560,
    y: 360,
    at: 262,
  },
  {
    title: 'claude — review',
    lines: [
      { t: "❯ here's the diff from the other session:", c: C.dim },
      { t: '  (pasted 214 lines)', c: C.dim },
    ],
    tag: { text: 'copy-paste between windows', color: C.yellow },
    x: 1300,
    y: 700,
    at: 300,
  },
];

export const TermCard: React.FC<{ t: Term; scale?: number; style?: React.CSSProperties; showTag?: boolean }> = ({
  t,
  scale = 1,
  style,
  showTag = true,
}) => (
  <div style={{ position: 'absolute', left: t.x, top: t.y, transform: `scale(${scale})`, transformOrigin: 'top left', ...style }}>
    <Window title={t.title} width={600} height={210} style={{ position: 'relative' }}>
      <div style={{ padding: '14px 18px', fontSize: 18, lineHeight: 1.55 }}>
        {t.lines.map((l, i) => (
          <div key={i} style={{ color: l.c ?? C.text, whiteSpace: 'pre' }}>
            {l.t}
          </div>
        ))}
      </div>
    </Window>
    {showTag && t.tag && (
      <Tag color={t.tag.color} style={{ right: -18, top: -20 }}>
        {t.tag.text}
      </Tag>
    )}
  </div>
);

export const Chaos: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const open = TERMS.filter((t) => frame >= t.at).length;
  const shake = interpolate(frame, [330, 420, 600], [0, 1, 1.4], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <Background glow={C.red}>
      <AbsoluteFill
        style={{
          transform: `translate(${Math.sin(frame * 1.7) * 3 * shake}px, ${Math.cos(frame * 2.3) * 2 * shake}px)`,
        }}
      >
        {TERMS.map((t, i) => {
          const s = spring({ frame: frame - t.at, fps, config: { damping: 14, stiffness: 140 } });
          if (frame < t.at) return null;
          return (
            <TermCard
              key={i}
              t={t}
              showTag={false}
              style={{
                opacity: s,
                transform: `scale(${0.7 + s * 0.3}) rotate(${(i % 2 ? 1 : -1) * (1 - s) * 6}deg)`,
                zIndex: i,
              }}
            />
          );
        })}
        {/* labels sit above every window so none gets buried */}
        {TERMS.map((t, i) => {
          if (!t.tag || frame < t.at + 12) return null;
          const s = spring({ frame: frame - t.at - 12, fps, config: { damping: 12, stiffness: 180 } });
          return (
            <Tag key={`tag${i}`} color={t.tag.color} style={{ left: t.x + 600 - 18, top: t.y - 20, transform: `translateX(-100%) scale(${s})`, transformOrigin: 'right center', zIndex: 30 }}>
              {t.tag.text}
            </Tag>
          );
        })}
      </AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          left: 70,
          bottom: 56,
          fontFamily: FONT.mono,
          fontSize: 26,
          color: C.dim,
          zIndex: 40,
          background: '#000a',
          padding: '10px 18px',
          borderRadius: 10,
        }}
      >
        terminals open for one project:{' '}
        <span style={{ color: open > 4 ? C.red : C.text, fontWeight: 700, fontSize: 34 }}>{open}</span>
      </div>
      <div style={{ position: 'absolute', top: 40, left: 0, right: 0, zIndex: 60 }}>
        <Caption text="One project." at={0} out={150} size={72} />
        <Caption text="Seven terminals." at={170} out={330} size={72} highlight={['Seven']} />
        <Caption text="Not one of them knows what the others know." at={350} size={60} />
      </div>
    </Background>
  );
};

export const Pain: React.FC = () => {
  const frame = useCurrentFrame();
  const rows = [
    { a: 'Open a new session', b: 'explain the whole project again', at: 10 },
    { a: 'Stop the long-running task', b: 'lose twenty minutes of work', at: 70 },
    { a: 'Juggle windows and stashes', b: 'lose track of what is where', at: 130 },
  ];
  return (
    <Background glow={C.red}>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'column', gap: 34 }}>
        {rows.map((r, i) => {
          const o = fadeIn(frame, r.at, 20);
          return (
            <div
              key={i}
              style={{
                opacity: o,
                transform: `translateX(${(1 - o) * -60}px)`,
                display: 'flex',
                alignItems: 'center',
                gap: 28,
                fontFamily: FONT.sans,
                fontSize: 50,
                fontWeight: 700,
                color: C.text,
                width: 1400,
              }}
            >
              <span style={{ color: C.red, fontSize: 56, width: 60 }}>✕</span>
              <span style={{ width: 640 }}>{r.a}</span>
              <span style={{ color: C.faint }}>→</span>
              <span style={{ color: C.dim }}>{r.b}</span>
            </div>
          );
        })}
      </AbsoluteFill>
    </Background>
  );
};

/** All the windows fly into one, and pitstop appears. */
export const Collapse: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fly = (i: number) =>
    interpolate(frame, [10 + i * 6, 70 + i * 6], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.inOut(Easing.cubic),
    });
  const logo = spring({ frame: frame - 95, fps, config: { damping: 14 } });
  const draw = interpolate(frame, [95, 160], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <Background glow={C.accent}>
      {TERMS.map((t, i) => {
        const p = fly(i);
        const cx = 960 - 300;
        const cy = 540 - 105;
        return (
          <TermCard
            key={i}
            t={t}
            showTag={p < 0.3}
            style={{
              left: t.x + (cx - t.x) * p,
              top: t.y + (cy - t.y) * p,
              opacity: 1 - p,
              transform: `scale(${1 - p * 0.6})`,
              transformOrigin: 'center',
              zIndex: i,
            }}
          />
        );
      })}
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}>
        <div style={{ transform: `scale(${0.6 + logo * 0.4})`, opacity: logo }}>
          <Logo size={150} draw={draw} />
        </div>
        <div
          style={{
            marginTop: 40,
            opacity: fadeIn(frame, 150, 20),
            fontFamily: FONT.sans,
            fontSize: 44,
            fontWeight: 600,
            color: C.dim,
          }}
        >
          One terminal. Every session. <span style={{ color: C.text }}>Full context.</span>
        </div>
      </AbsoluteFill>
    </Background>
  );
};
