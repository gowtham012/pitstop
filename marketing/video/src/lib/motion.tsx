import React from 'react';
import { AbsoluteFill, Easing, interpolate, random, useCurrentFrame } from 'remotion';
import { C, FONT } from '../theme';

export const BEAT = 30; // frames per beat at 120 BPM, 60 fps

export type EaseFn = (t: number) => number;
export const ease = {
  inOut: Easing.inOut(Easing.cubic),
  out: Easing.out(Easing.cubic),
  outExpo: Easing.out(Easing.exp),
  inExpo: Easing.in(Easing.exp),
  in: Easing.in(Easing.cubic),
};

/** Keyframed value: [[frame, value], …] with an easing per segment. */
export function kf(frame: number, points: [number, number][], e: EaseFn = ease.inOut): number {
  if (frame <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [f0, v0] = points[i - 1]!;
    const [f1, v1] = points[i]!;
    if (frame <= f1) return interpolate(frame, [f0, f1], [v0, v1], { easing: e });
  }
  return points[points.length - 1]![1];
}

/** A short decaying shake after each impact frame. */
export function shake(frame: number, impacts: number[], amp = 14): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const at of impacts) {
    const d = frame - at;
    if (d < 0 || d > 18) continue;
    const k = Math.exp(-d / 5) * amp;
    x += Math.sin(d * 2.9 + at) * k;
    y += Math.cos(d * 3.7 + at) * k;
  }
  return { x, y };
}

/** Big kinetic word: slams in from huge and blurred, holds, then flies past the camera. */
export const Slam: React.FC<{
  text: string;
  at: number;
  dur: number;
  size?: number;
  color?: string;
  accent?: string;
  sub?: string;
  align?: 'center' | 'left';
  y?: number;
  outline?: boolean;
}> = ({ text, at, dur, size = 150, color = C.text, accent, sub, align = 'center', y = 0, outline }) => {
  const frame = useCurrentFrame();
  const t = frame - at;
  if (t < 0 || t > dur) return null;
  const inP = interpolate(t, [0, 9], [0, 1], { extrapolateRight: 'clamp', easing: ease.outExpo });
  const outP = interpolate(t, [dur - 8, dur], [0, 1], { extrapolateLeft: 'clamp', easing: ease.in });
  const scale = interpolate(inP, [0, 1], [2.6, 1]) * interpolate(outP, [0, 1], [1, 1.5]);
  const blur = (1 - inP) * 24 + outP * 16;
  const opacity = Math.min(inP * 1.4, 1) * (1 - outP);
  const drift = t * 0.06; // keeps the word alive while it holds
  const words = text.split(' ');
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: align === 'center' ? 'center' : 'flex-start',
        paddingLeft: align === 'left' ? 120 : 0,
        transform: `translateY(${y}px)`,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          transform: `scale(${scale + drift * 0.002})`,
          filter: `blur(${blur}px)`,
          opacity,
          textAlign: align,
          fontFamily: FONT.sans,
          fontWeight: 800,
          fontSize: size,
          lineHeight: 0.95,
          letterSpacing: -size * 0.045,
          color: outline ? 'transparent' : color,
          WebkitTextStroke: outline ? `3px ${color}` : undefined,
          textShadow: outline ? 'none' : `0 10px 60px #000c`,
          textTransform: 'uppercase',
        }}
      >
        {words.map((w, i) => (
          <span key={i} style={{ color: accent && i === words.length - 1 ? accent : undefined }}>
            {w}
            {i < words.length - 1 ? ' ' : ''}
          </span>
        ))}
        {sub && (
          <div
            style={{
              marginTop: 28,
              fontSize: size * 0.22,
              fontWeight: 600,
              letterSpacing: 0,
              textTransform: 'none',
              color: C.dim,
              WebkitTextStroke: '0',
            }}
          >
            {sub}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** Full-screen flash at `at`, fading over `len` frames. */
export const Flash: React.FC<{ at: number; len?: number; color?: string; peak?: number }> = ({
  at,
  len = 14,
  color = '#fff',
  peak = 1,
}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [at - 2, at, at + len], [0, peak, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  if (o <= 0) return null;
  return <AbsoluteFill style={{ background: color, opacity: o, mixBlendMode: 'screen' }} />;
};

/** Rotating light rays behind a logo. */
export const Rays: React.FC<{ opacity: number; color?: string }> = ({ opacity, color = C.accent }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        opacity,
        background: `repeating-conic-gradient(from ${frame * 0.4}deg at 50% 50%, ${color}26 0deg 6deg, transparent 6deg 18deg)`,
        maskImage: 'radial-gradient(circle at center, black 0%, transparent 62%)',
        WebkitMaskImage: 'radial-gradient(circle at center, black 0%, transparent 62%)',
      }}
    />
  );
};

/** A burst of sparks flying out from the centre, starting at `at`. */
export const Burst: React.FC<{ at: number; count?: number; color?: string; seed?: string }> = ({
  at,
  count = 80,
  color = C.accent,
  seed = 'burst',
}) => {
  const frame = useCurrentFrame();
  const t = frame - at;
  if (t < 0 || t > 120) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: count }, (_, i) => {
        const a = random(`${seed}a${i}`) * Math.PI * 2;
        const speed = 6 + random(`${seed}s${i}`) * 22;
        const d = speed * t * Math.exp(-t / 70);
        const size = 2 + random(`${seed}z${i}`) * 5;
        const o = Math.max(0, 1 - t / (60 + random(`${seed}l${i}`) * 60));
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 960 + Math.cos(a) * d,
              top: 540 + Math.sin(a) * d,
              width: size * 3,
              height: size,
              borderRadius: size,
              background: i % 3 ? color : '#fff',
              opacity: o,
              transform: `rotate(${a}rad)`,
              boxShadow: `0 0 ${size * 3}px ${color}`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/** Slow floating dust that gives depth to empty space. */
export const Dust: React.FC<{ count?: number; color?: string }> = ({ count = 50, color = '#ffffff' }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: count }, (_, i) => {
        const x = (random(`dx${i}`) * 2200 + frame * (0.2 + random(`dv${i}`) * 0.6)) % 2200 - 140;
        const y = random(`dy${i}`) * 1080 + Math.sin(frame / 60 + i) * 12;
        const s = 1 + random(`ds${i}`) * 2.5;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: s,
              height: s,
              borderRadius: s,
              background: color,
              opacity: 0.08 + random(`do${i}`) * 0.25,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/** Film grain + vignette on top of everything, for a filmic finish. */
export const Finish: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <AbsoluteFill
        style={{
          background: 'radial-gradient(ellipse at center, transparent 55%, #000000b0 100%)',
        }}
      />
      <AbsoluteFill
        style={{
          opacity: 0.05,
          backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='${frame % 7}'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")`,
        }}
      />
    </AbsoluteFill>
  );
};
