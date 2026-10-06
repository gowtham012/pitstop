import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background, Logo, typed } from '../components/ui';
import { BEAT, Burst, Dust, ease, Flash, Rays } from '../lib/motion';
import { C, FONT } from '../theme';

type Cut = { word: string; sub: string; color: string; glyph: string; invert?: boolean };

const CUTS: Cut[] = [
  { word: 'Conflict radar', sub: 'Two sessions, one file? You know first.', color: C.yellow, glyph: '◎' },
  { word: 'Test gate', sub: 'Nothing red gets merged.', color: C.green, glyph: '✓' },
  { word: 'Resume', sub: 'Reboot. Every session comes back.', color: C.blue, glyph: '↻' },
  { word: 'Cloud forks', sub: 'Send a fork to the cloud.', color: C.accent, glyph: '☁', invert: true },
  { word: 'Codex', sub: 'Fork into Codex…', color: C.text, glyph: '›_' },
  { word: 'Gemini', sub: '…or Gemini CLI.', color: C.blue, glyph: '✦' },
  { word: 'Report', sub: 'Every fork, ready for your PR.', color: C.text, glyph: '≡' },
  { word: 'F2 · F3 · F10', sub: 'Fork. Merge. Quit.', color: C.accent, glyph: '⌨', invert: true },
  { word: 'Write guard', sub: 'Forks stay in their own worktree.', color: C.green, glyph: '◆' },
  { word: 'Delete', sub: 'Throw a fork away in one key.', color: C.red, glyph: '✕' },
  { word: 'Auto-updates', sub: 'Always the latest.', color: C.blue, glyph: '⇡' },
  { word: 'Open source', sub: 'MIT licensed. Built on Claude Code.', color: '#000', glyph: '★', invert: true },
];

/** 2220–2580: twelve one-beat cuts. */
export const Montage: React.FC = () => {
  const frame = useCurrentFrame();
  const i = Math.min(CUTS.length - 1, Math.floor(frame / BEAT));
  const t = frame - i * BEAT;
  const c = CUTS[i]!;
  const zoom = interpolate(t, [0, BEAT], [1.18, 1], { easing: ease.outExpo });
  const tilt = (i % 2 ? 1 : -1) * interpolate(t, [0, BEAT], [3, 0], { easing: ease.out });
  const bg = c.invert ? C.accent : C.bg;
  const fg = c.invert ? '#000' : C.text;
  const slide = interpolate(t, [0, 8], [i % 2 ? 120 : -120, 0], { extrapolateRight: 'clamp', easing: ease.outExpo });
  return (
    <AbsoluteFill style={{ background: bg, overflow: 'hidden' }}>
      {!c.invert && (
        <AbsoluteFill style={{ background: `radial-gradient(900px 600px at 70% 40%, ${c.color}30, transparent 70%)` }} />
      )}
      <AbsoluteFill
        style={{
          transform: `scale(${zoom}) rotate(${tilt}deg)`,
          justifyContent: 'center',
          alignItems: 'center',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            width: 150,
            height: 150,
            borderRadius: 36,
            border: `4px solid ${c.invert ? '#000' : c.color}`,
            color: c.invert ? '#000' : c.color,
            background: c.invert ? '#00000014' : `${c.color}1c`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: FONT.mono,
            fontSize: 72,
            fontWeight: 700,
            marginBottom: 46,
            transform: `translateX(${-slide}px)`,
          }}
        >
          {c.glyph}
        </div>
        <div
          style={{
            fontFamily: FONT.sans,
            fontWeight: 800,
            fontSize: 190,
            letterSpacing: -9,
            lineHeight: 0.95,
            textTransform: 'uppercase',
            color: fg,
            transform: `translateX(${slide}px)`,
            textAlign: 'center',
          }}
        >
          {c.word}
        </div>
        <div style={{ marginTop: 30, fontFamily: FONT.sans, fontWeight: 600, fontSize: 46, color: c.invert ? '#000000aa' : C.dim }}>
          {c.sub}
        </div>
      </AbsoluteFill>
      <Flash at={i * BEAT} len={6} peak={0.12} />
    </AbsoluteFill>
  );
};

/** 2580–3060: logo, promise, install. */
export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, stiffness: 120 } });
  const draw = interpolate(frame, [0, 70], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const rise = (at: number) => ({
    opacity: interpolate(frame, [at, at + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    transform: `translateY(${interpolate(frame, [at, at + 18], [24, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease.out })}px)`,
  });
  const sweep = interpolate(frame, [20, 80], [-40, 140], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const cmds = [
    { t: 'git clone https://github.com/gowtham012/pitstop && cd pitstop', at: 110 },
    { t: 'npm install && npm install -g .', at: 175 },
    { t: 'pit', at: 220 },
  ];
  return (
    <Background>
      <Dust count={70} color={C.accent} />
      <Rays opacity={interpolate(frame, [0, 30, 300, 480], [0, 0.8, 0.5, 0.3])} />
      <Burst at={0} count={90} seed="outro" />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}>
        <div style={{ transform: `scale(${0.5 + pop * 0.5})`, opacity: Math.min(1, pop * 1.4), position: 'relative' }}>
          <Logo size={160} draw={draw} />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: `linear-gradient(105deg, transparent ${sweep - 12}%, #ffffff55 ${sweep}%, transparent ${sweep + 12}%)`,
              mixBlendMode: 'overlay',
            }}
          />
        </div>
        <div style={{ marginTop: 34, fontFamily: FONT.sans, fontSize: 56, fontWeight: 800, letterSpacing: -1.5, color: C.text, ...rise(40) }}>
          Fork your Claude session. <span style={{ color: C.accent }}>Don&apos;t stop it.</span>
        </div>
        <div
          style={{
            marginTop: 56,
            width: 1120,
            background: '#111319e6',
            border: '1px solid #ffffff1f',
            borderRadius: 18,
            padding: '26px 36px',
            fontFamily: FONT.mono,
            fontSize: 27,
            lineHeight: 1.8,
            boxShadow: `0 30px 90px #000c, 0 0 60px ${C.accent}22`,
            ...rise(90),
          }}
        >
          {cmds.map((c) => (
            <div key={c.t} style={{ whiteSpace: 'pre', color: C.text, opacity: frame >= c.at ? 1 : 0 }}>
              <span style={{ color: C.green }}>$ </span>
              {typed(c.t, frame, c.at, 80)}
              {frame >= c.at && frame < c.at + 60 && Math.floor(frame / 12) % 2 === 0 ? <span style={{ color: C.accent }}>▌</span> : null}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 50, display: 'flex', gap: 24, fontFamily: FONT.sans, fontSize: 30, fontWeight: 600, color: C.dim, ...rise(260) }}>
          <span>Open source</span>
          <span style={{ color: C.faint }}>·</span>
          <span>MIT</span>
          <span style={{ color: C.faint }}>·</span>
          <span style={{ color: C.text }}>github.com/gowtham012/pitstop</span>
        </div>
      </AbsoluteFill>
      <Flash at={0} len={18} peak={0.6} />
    </Background>
  );
};
