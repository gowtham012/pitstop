import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion';
import { C, FONT } from '../theme';

/** Text typed out at `cps` characters per second, starting at frame `start`. */
export function typed(text: string, frame: number, start: number, cps = 32, fps = 60): string {
  return text.slice(0, Math.max(0, Math.floor(((frame - start) * cps) / fps)));
}

/** 0→1 spring that starts at `delay` frames. */
export function useSpring(delay = 0, config: { damping?: number; stiffness?: number; mass?: number } = {}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping: 18, stiffness: 120, ...config } });
}

export function fadeIn(frame: number, start: number, len = 18): number {
  return interpolate(frame, [start, start + len], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
}

/** Deep background with a slow glow and a faint grid. */
export const Background: React.FC<{ glow?: string; children?: React.ReactNode }> = ({
  glow = C.accent,
  children,
}) => {
  const frame = useCurrentFrame();
  const x = 50 + Math.sin(frame / 140) * 12;
  const y = 40 + Math.cos(frame / 170) * 10;
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(1100px 700px at ${x}% ${y}%, ${glow}22, transparent 70%), radial-gradient(900px 600px at ${100 - x}% ${100 - y}%, ${C.blue}18, transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.faint}22 1px, transparent 1px), linear-gradient(90deg, ${C.faint}22 1px, transparent 1px)`,
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
        }}
      />
      {children}
    </AbsoluteFill>
  );
};

/** A terminal window with generic title-bar dots. */
export const Window: React.FC<{
  title: string;
  width: number;
  height: number;
  style?: React.CSSProperties;
  tint?: string;
  /** Let children move in 3D (no clipping), for exploded views. */
  open3d?: boolean;
  children?: React.ReactNode;
}> = ({ title, width, height, style, tint, open3d, children }) => (
  <div
    style={{
      position: 'absolute',
      width,
      height,
      borderRadius: 14,
      background: C.term,
      boxShadow: `0 30px 80px #000000aa, 0 0 0 1px #ffffff14${tint ? `, 0 0 0 2px ${tint}` : ''}`,
      overflow: open3d ? 'visible' : 'hidden',
      transformStyle: open3d ? 'preserve-3d' : undefined,
      display: 'flex',
      flexDirection: 'column',
      ...style,
    }}
  >
    <div
      style={{
        height: 38,
        flexShrink: 0,
        background: C.termBar,
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 8,
        borderBottom: '1px solid #00000066',
      }}
    >
      {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
        <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />
      ))}
      <div
        style={{
          flex: 1,
          textAlign: 'center',
          color: C.dim,
          fontFamily: FONT.sans,
          fontSize: 15,
          fontWeight: 600,
          marginRight: 60,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
    </div>
    <div style={{ flex: 1, position: 'relative', fontFamily: FONT.mono, transformStyle: open3d ? 'preserve-3d' : undefined }}>
      {children}
    </div>
  </div>
);

export type Seg = { text: string; color: string; bold?: boolean };

/** A pane exactly like pit draws it: rounded frame, title and state in the top border. */
export const Pane: React.FC<{
  focused?: boolean;
  segs: Seg[];
  cost?: string;
  notice?: string;
  style?: React.CSSProperties;
  fontSize?: number;
  children?: React.ReactNode;
}> = ({ focused, segs, cost, notice, style, fontSize = 17, children }) => {
  const border = focused ? C.accent : C.frame;
  return (
    <div
      style={{
        position: 'absolute',
        border: `2px solid ${border}`,
        borderRadius: 10,
        background: C.term,
        boxShadow: focused ? `0 0 28px ${C.accent}33` : 'none',
        fontSize,
        lineHeight: 1.55,
        color: C.text,
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: -fontSize * 0.8,
          left: 14,
          display: 'flex',
          gap: 10,
          background: C.term,
          padding: '0 8px',
          whiteSpace: 'nowrap',
          maxWidth: 'calc(100% - 40px)',
          overflow: 'hidden',
        }}
      >
        {segs.map((s, i) => (
          <span key={i} style={{ color: s.color, fontWeight: s.bold ? 700 : 400 }}>
            {i > 0 ? <span style={{ color: border, marginRight: 10 }}>─</span> : null}
            {s.text}
          </span>
        ))}
      </div>
      <div style={{ position: 'absolute', inset: '14px 18px', overflow: 'hidden' }}>{children}</div>
      {(cost || notice) && (
        <div
          style={{
            position: 'absolute',
            bottom: -fontSize * 0.8,
            left: 14,
            right: 14,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          {notice ? (
            <span style={{ background: C.term, padding: '0 8px', color: C.yellow, fontWeight: 700 }}>{notice}</span>
          ) : (
            <span />
          )}
          {cost && <span style={{ background: C.term, padding: '0 8px', color: C.dim }}>{cost}</span>}
        </div>
      )}
    </div>
  );
};

/** One line in a pane; fades and slides in at `at`. */
export const L: React.FC<{ at?: number; color?: string; bold?: boolean; children: React.ReactNode }> = ({
  at = 0,
  color = C.text,
  bold,
  children,
}) => {
  const frame = useCurrentFrame();
  const o = fadeIn(frame, at, 12);
  return (
    <div
      style={{
        opacity: o,
        transform: `translateY(${(1 - o) * 8}px)`,
        color,
        fontWeight: bold ? 700 : 400,
        whiteSpace: 'pre',
      }}
    >
      {children}
    </div>
  );
};

export const Dot: React.FC<{ color?: string }> = ({ color = C.green }) => (
  <span style={{ color }}>● </span>
);

/** pit's bottom bar: session tabs on the left, buttons (or a message) on the right. */
export const BottomBar: React.FC<{
  tabs: { label: string; glyph: string; color: string; focused?: boolean }[];
  message?: { text: string; color: string };
  pressed?: string;
  style?: React.CSSProperties;
}> = ({ tabs, message, pressed, style }) => {
  const buttons = ['+ Fork F2', 'Merge F3', 'Diff F4', 'Tree F5', 'Delete F8', '? F1', 'Quit F10'];
  return (
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
        padding: '0 10px',
        gap: 14,
        fontSize: 16,
        fontFamily: FONT.mono,
        ...style,
      }}
    >
      {tabs.map((t, i) => (
        <span
          key={i}
          style={{
            color: t.focused ? '#000' : C.text,
            background: t.focused ? C.accent : 'transparent',
            fontWeight: t.focused ? 700 : 400,
            padding: '2px 8px',
            borderRadius: 4,
            whiteSpace: 'nowrap',
          }}
        >
          {t.focused ? '▸' : ''}
          {i + 1} <span style={{ color: t.focused ? '#000' : t.color }}>{t.glyph}</span> {t.label}
        </span>
      ))}
      <div style={{ flex: 1 }} />
      {message ? (
        <span style={{ color: message.color, fontWeight: 700, whiteSpace: 'nowrap' }}>{message.text}</span>
      ) : (
        buttons.map((b) => {
          const on = pressed && b.endsWith(pressed);
          return (
            <span
              key={b}
              style={{
                background: b.startsWith('Quit') ? C.quit : on ? C.accent : C.button,
                color: on ? '#000' : '#fff',
                padding: '2px 9px',
                borderRadius: 4,
                whiteSpace: 'nowrap',
                transform: on ? 'scale(1.12)' : 'none',
                boxShadow: on ? `0 0 18px ${C.accent}` : 'none',
              }}
            >
              {b}
            </span>
          );
        })
      )}
    </div>
  );
};

/** A big keyboard key that pops in, presses down at `pressAt`, and fades out. */
export const KeyCap: React.FC<{ label: string; at: number; pressAt: number; hint?: string }> = ({
  label,
  at,
  pressAt,
  hint,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - at, fps, config: { damping: 12, stiffness: 160 } });
  const press = interpolate(frame, [pressAt, pressAt + 5, pressAt + 12], [0, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const out = interpolate(frame, [pressAt + 30, pressAt + 45], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const ring = interpolate(frame, [pressAt, pressAt + 30], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: `translate(-50%, -50%) scale(${pop * (1 - press * 0.08)})`,
        opacity: out,
        textAlign: 'center',
        zIndex: 50,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: 90,
          width: 360 * ring,
          height: 360 * ring,
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          border: `3px solid ${C.accent}`,
          opacity: frame >= pressAt ? 1 - ring : 0,
        }}
      />
      <div
        style={{
          width: 180,
          height: 180,
          borderRadius: 28,
          background: 'linear-gradient(180deg, #3a3a3a, #232323)',
          boxShadow: `0 ${16 - press * 12}px 0 #0d0d0d, 0 30px 60px #000c, inset 0 2px 0 #ffffff22, 0 0 ${40 * press}px ${C.accent}`,
          transform: `translateY(${press * 12}px)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: frame >= pressAt ? C.accent : '#fff',
          fontFamily: FONT.sans,
          fontWeight: 800,
          fontSize: 64,
        }}
      >
        {label}
      </div>
      {hint && (
        <div style={{ marginTop: 34, color: C.dim, fontFamily: FONT.sans, fontSize: 24, fontWeight: 600 }}>
          {hint}
        </div>
      )}
    </div>
  );
};

/** A headline that rises in word by word. */
export const Caption: React.FC<{
  text: string;
  at?: number;
  out?: number;
  size?: number;
  color?: string;
  highlight?: string[];
  style?: React.CSSProperties;
}> = ({ text, at = 0, out, size = 64, color = C.text, highlight = [], style }) => {
  const frame = useCurrentFrame();
  const fade = out === undefined ? 1 : interpolate(frame, [out, out + 15], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        textAlign: 'center',
        fontFamily: FONT.sans,
        fontWeight: 800,
        fontSize: size,
        letterSpacing: -1.5,
        color,
        opacity: fade,
        ...style,
      }}
    >
      {text.split(' ').map((w, i) => {
        const o = fadeIn(frame, at + i * 4, 16);
        const hl = highlight.some((h) => w.replace(/[.,!?]/g, '') === h);
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: o,
              transform: `translateY(${(1 - o) * 28}px)`,
              marginRight: size * 0.26,
              color: hl ? C.accent : undefined,
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

/** Small pill label. */
export const Tag: React.FC<{ color: string; children: React.ReactNode; style?: React.CSSProperties }> = ({
  color,
  children,
  style,
}) => (
  <div
    style={{
      position: 'absolute',
      background: `linear-gradient(${color}26, ${color}26), #101217`,
      border: `2px solid ${color}`,
      color,
      borderRadius: 999,
      padding: '6px 16px',
      fontFamily: FONT.sans,
      fontWeight: 700,
      fontSize: 20,
      whiteSpace: 'nowrap',
      boxShadow: `0 8px 30px #000a`,
      ...style,
    }}
  >
    {children}
  </div>
);

/** The pitstop mark: a session line that branches off and comes back. */
export const Mark: React.FC<{ size: number; draw?: number }> = ({ size, draw = 1 }) => {
  const len = 260;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120">
      <defs>
        <linearGradient id="mg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor={C.accent} />
          <stop offset="1" stopColor={C.accentDeep} />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="112" height="112" rx="28" fill="#15171c" stroke="#ffffff1a" strokeWidth="2" />
      <path d="M30 88 L30 32" stroke={C.blue} strokeWidth="9" strokeLinecap="round" fill="none"
        strokeDasharray={len} strokeDashoffset={len * (1 - draw)} />
      <path d="M30 42 C 30 62, 90 50, 90 70 C 90 84, 50 84, 30 80" stroke="url(#mg)" strokeWidth="9"
        strokeLinecap="round" fill="none" strokeDasharray={len} strokeDashoffset={len * (1 - Math.max(0, draw * 1.3 - 0.3))} />
      <circle cx="30" cy="32" r="8" fill={C.blue} opacity={draw} />
      <circle cx="90" cy="70" r="8" fill={C.accent} opacity={Math.max(0, draw * 2 - 1)} />
    </svg>
  );
};

export const Logo: React.FC<{ size?: number; draw?: number }> = ({ size = 120, draw = 1 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.22 }}>
    <Mark size={size} draw={draw} />
    <span
      style={{
        fontFamily: FONT.sans,
        fontWeight: 800,
        fontSize: size * 0.82,
        letterSpacing: -size * 0.03,
        color: C.text,
      }}
    >
      pit<span style={{ color: C.accent }}>stop</span>
    </span>
  </div>
);
