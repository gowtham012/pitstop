import React from 'react';
import { AbsoluteFill, interpolate, random, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { TERMS } from '../scenes/Problem';
import { Background, Logo, Tag, typed, Window } from '../components/ui';
import { Burst, Dust, ease, Flash, kf, Rays, shake, Slam } from '../lib/motion';
import { C, FONT } from '../theme';

const W = 600;
const H = 210;
const COUNT = 26;

type Placed = { x: number; y: number; z: number; ry: number; at: number; i: number };

/** Where every terminal sits in the 3D cloud, and when it pops up. */
export const CLOUD: Placed[] = Array.from({ length: COUNT }, (_, i) => {
  if (i === 0) return { x: 0, y: 0, z: 0, ry: 0, at: 0, i };
  const r = (k: string) => random(`cloud-${k}-${i}`);
  return {
    x: (r('x') * 2 - 1) * 1750,
    y: (r('y') * 2 - 1) * 950,
    z: -200 - r('z') * 2600,
    ry: (r('r') * 2 - 1) * 28,
    at: 120 + Math.round(i * i * 0.55 + i * 10),
    i,
  };
});

export function camera(frame: number) {
  return {
    z: kf(frame, [[0, 720], [110, 560], [600, -1050]], ease.inOut),
    rx: kf(frame, [[0, 0], [600, 9]]),
    ry: kf(frame, [[0, 0], [600, -16]]),
    rz: Math.sin(frame / 90) * 1.2,
  };
}

const TermWindow: React.FC<{ p: Placed; frame: number }> = ({ p, frame }) => {
  const term = TERMS[p.i % TERMS.length]!;
  const first = p.i === 0;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H }}>
      <Window title={first ? 'claude — my-app' : term.title} width={W} height={H} style={{ position: 'relative' }}>
        <div style={{ padding: '14px 18px', fontSize: 18, lineHeight: 1.55 }}>
          {first ? (
            <>
              <div style={{ color: C.text }}>
                <span style={{ color: C.green }}>$ </span>
                {typed('claude', frame, 20, 14)}
              </div>
              {frame > 70 && <div style={{ color: C.dim }}>❯ run the full integration suite</div>}
              {frame > 95 && (
                <div>
                  <span style={{ color: C.green }}>● </span>Running the suite. ~20 min.
                </div>
              )}
            </>
          ) : (
            term.lines.map((l, k) => (
              <div key={k} style={{ color: l.c ?? C.text, whiteSpace: 'pre' }}>
                {l.t}
              </div>
            ))
          )}
        </div>
      </Window>
      {!first && term.tag && p.i < TERMS.length + 3 && (
        <Tag color={term.tag.color} style={{ right: -18, top: -22, fontSize: 22 }}>
          {term.tag.text}
        </Tag>
      )}
    </div>
  );
};

/** World of terminal windows seen through the camera. */
export const Cloud: React.FC<{ frame: number; spiral?: number }> = ({ frame, spiral = 0 }) => {
  const { fps } = useVideoConfig();
  const cam = camera(Math.min(frame, 600));
  const sh = shake(frame, [120, 240, 360, 480], 10);
  return (
    <AbsoluteFill style={{ perspective: 1400, perspectiveOrigin: '50% 50%' }}>
      <AbsoluteFill
        style={{
          transformStyle: 'preserve-3d',
          transform: `translate3d(${sh.x}px, ${sh.y}px, ${cam.z + spiral * 900}px) rotateX(${cam.rx}deg) rotateY(${cam.ry}deg) rotateZ(${cam.rz + spiral * 40}deg)`,
        }}
      >
        {CLOUD.map((p) => {
          if (frame < p.at) return null;
          const s = spring({ frame: frame - p.at, fps, config: { damping: 15, stiffness: 120 } });
          // the vortex: spin in towards the centre and shrink to nothing
          const ang = spiral * (2.5 + random(`sp${p.i}`)) * Math.PI;
          const rad = 1 - spiral;
          const x = (p.x * Math.cos(ang) - p.y * Math.sin(ang)) * rad;
          const y = (p.x * Math.sin(ang) + p.y * Math.cos(ang)) * rad;
          const z = p.z * rad;
          return (
            <div
              key={p.i}
              style={{
                position: 'absolute',
                left: 960 - W / 2,
                top: 540 - H / 2,
                transformStyle: 'preserve-3d',
                transform: `translate3d(${x}px, ${y}px, ${z - (1 - s) * 500}px) rotateY(${p.ry * rad}deg) scale(${(0.5 + 0.5 * s) * Math.max(0.02, rad)})`,
                opacity: Math.min(1, s * 1.3) * Math.min(1, rad * 3),
              }}
            >
              <TermWindow p={p} frame={frame} />
            </div>
          );
        })}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** 0–600: one terminal becomes twenty-six. */
export const Chaos: React.FC = () => {
  const frame = useCurrentFrame();
  const open = CLOUD.filter((p) => frame >= p.at).length;
  const pulse = frame > 240 ? (Math.sin((frame / 30) * Math.PI * 2) * 0.5 + 0.5) * interpolate(frame, [240, 600], [0.15, 0.45]) : 0;
  return (
    <Background glow={C.red}>
      <Dust />
      <Cloud frame={frame} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at center, transparent 40%, ${C.red}55 100%)`, opacity: pulse }} />
      <Slam text="One project." at={120} dur={100} size={170} />
      <Slam text="Twelve terminals." at={240} dur={100} size={170} accent={C.red} />
      <Slam text="Zero shared context." at={360} dur={100} size={150} accent={C.red} />
      <Slam text="Re-explain. Stash. Repeat." at={480} dur={110} size={130} />
      <div
        style={{
          position: 'absolute',
          left: 70,
          bottom: 60,
          fontFamily: FONT.mono,
          fontSize: 28,
          color: C.dim,
          background: '#000b',
          padding: '12px 20px',
          borderRadius: 12,
          border: '1px solid #ffffff14',
          opacity: interpolate(frame, [110, 130], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        }}
      >
        terminals open: <span style={{ color: open > 6 ? C.red : C.text, fontWeight: 700, fontSize: 40 }}>{open}</span>
      </div>
    </Background>
  );
};

/** 600–720: everything stops. */
export const Break: React.FC = () => {
  const frame = useCurrentFrame();
  const g = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <Background glow={C.red}>
      <AbsoluteFill style={{ filter: `grayscale(${g}) brightness(${1 - g * 0.65}) blur(${g * 3}px)` }}>
        <Cloud frame={599} />
      </AbsoluteFill>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ fontFamily: FONT.mono, fontSize: 56, color: C.text }}>
          {typed("there's a better way.", frame, 14, 22)}
          <span style={{ opacity: Math.floor(frame / 15) % 2 ? 0 : 1, color: C.accent }}>▌</span>
        </div>
      </AbsoluteFill>
    </Background>
  );
};

/** 720–900: the terminals spiral into one point, a flash, and pitstop. */
export const Vortex: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sp = interpolate(frame, [0, 78], [0, 1], { extrapolateRight: 'clamp', easing: ease.inExpo });
  const logo = spring({ frame: frame - 80, fps, config: { damping: 11, stiffness: 140 } });
  const draw = interpolate(frame, [80, 140], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <Background glow={C.accent}>
      {frame < 80 && (
        <AbsoluteFill style={{ filter: `blur(${sp * 6}px)` }}>
          <Cloud frame={599} spiral={sp} />
        </AbsoluteFill>
      )}
      <Rays opacity={interpolate(frame, [80, 110], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} />
      <Burst at={80} count={110} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}>
        <div style={{ transform: `scale(${0.4 + logo * 0.6})`, opacity: Math.min(1, logo * 1.5) }}>
          <Logo size={170} draw={draw} />
        </div>
        <div
          style={{
            marginTop: 44,
            fontFamily: FONT.sans,
            fontSize: 46,
            fontWeight: 600,
            color: C.dim,
            opacity: interpolate(frame, [115, 135], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            transform: `translateY(${interpolate(frame, [115, 135], [20, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}px)`,
          }}
        >
          One terminal. Every session. <span style={{ color: C.text }}>Full context.</span>
        </div>
      </AbsoluteFill>
      <Flash at={80} len={22} />
    </Background>
  );
};
