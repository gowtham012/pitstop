import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { AREA, ForkContent, forkSegs, MainContent, mainSegs, PitWindow, WIN } from '../components/pit';
import { Background, Dot, KeyCap, L, Pane, typed } from '../components/ui';
import { Dust, ease, Flash, kf, shake, Slam } from '../lib/motion';
import { C } from '../theme';

const M = 18;
const TOP = 22;
const H = AREA.height - TOP - 20;
const FULL = AREA.width - 2 * M;
const HALF = (AREA.width - 3 * M) / 2;
const FORK_CENTER_X = WIN.left + M * 2 + HALF + HALF / 2;

/** A 3D stage: the pit window as a plane the camera flies around. */
const Stage: React.FC<{
  z: number;
  rx: number;
  ry: number;
  tx?: number;
  ty?: number;
  sh?: { x: number; y: number };
  children: React.ReactNode;
}> = ({ z, rx, ry, tx = 0, ty = 0, sh = { x: 0, y: 0 }, children }) => (
  <AbsoluteFill style={{ perspective: 1400 }}>
    <AbsoluteFill
      style={{
        transformStyle: 'preserve-3d',
        transform: `translate3d(${sh.x}px, ${sh.y}px, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) translate(${tx}px, ${ty}px)`,
      }}
    >
      {children}
    </AbsoluteFill>
  </AbsoluteFill>
);

/** Darkens the bottom of the frame so big words read over the terminal. */
const Scrim: React.FC<{ on: number }> = ({ on }) => (
  <AbsoluteFill
    style={{
      background: 'linear-gradient(180deg, transparent 35%, #000000d8 80%)',
      opacity: on,
      pointerEvents: 'none',
    }}
  />
);

const between = (f: number, ranges: [number, number][]) =>
  Math.max(
    ...ranges.map(([a, b]) =>
      interpolate(f, [a - 10, a, b, b + 10], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    ),
  );

/** 900–1500: the window flies in, F2 forks, the camera dives into the fork. */
export const Hero: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const split = spring({ frame: frame - 175, fps, config: { damping: 20, stiffness: 110 } });
  const forked = frame >= 175;
  const mainW = FULL + (HALF - FULL) * split;
  const zoom: [number, number][] = [[0, -2400], [70, 0], [205, 0], [265, 470], [420, 470], [485, -80], [600, -40]];
  const cam = {
    z: frame < 70 ? kf(frame, zoom, ease.outExpo) : kf(frame, zoom),
    rx: kf(frame, [[0, 30], [70, 7], [180, 0], [485, 0], [600, 5]]),
    ry: kf(frame, [[0, -34], [70, -9], [180, 0], [485, 0], [600, -7]]),
    tx: kf(frame, [[205, 0], [265, 960 - FORK_CENTER_X], [420, 960 - FORK_CENTER_X], [485, 0]]),
  };
  return (
    <Background>
      <Dust />
      <Stage {...cam} sh={shake(frame, [90], 16)}>
        <PitWindow
          prompt={frame >= 100 && frame < 172 ? typed('hotfix: fix the 500 on /login', frame, 104, 40) : undefined}
          pressed={frame >= 90 && frame < 100 ? 'F2' : undefined}
          tabs={[
            { label: 'main', glyph: '●', color: C.green, focused: !forked },
            ...(forked ? [{ label: 'fix-the-500', glyph: frame > 390 ? '○' : '●', color: C.green, focused: true }] : []),
          ]}
          message={forked && frame < 300 ? { text: 'forked fix-the-500 · full conversation · own worktree', color: C.green } : undefined}
        >
          <Pane focused={!forked} segs={mainSegs('working', !forked)} cost="$0.41" style={{ left: M, top: TOP, width: mainW, height: H }}>
            <MainContent />
          </Pane>
          {forked && (
            <Pane
              focused
              segs={forkSegs('fix-the-500', frame > 390 ? '○ idle' : '● working', frame > 390 ? C.dim : C.green, true)}
              cost="$0.07"
              style={{ left: M * 2 + mainW, top: TOP, width: HALF, height: H, opacity: split, transform: `translateX(${(1 - split) * 140}px)` }}
            >
              <ForkContent start={200} />
            </Pane>
          )}
        </PitWindow>
      </Stage>
      <Flash at={90} len={12} color={C.accent} peak={0.22} />
      <Flash at={176} len={16} color={C.accent} peak={0.18} />
      <KeyCap label="F2" at={45} pressAt={90} hint="fork the session" />
      <Scrim on={between(frame, [[232, 315], [322, 405], [492, 590]])} />
      <Slam text="Full context." at={232} dur={84} size={130} align="left" y={300} />
      <Slam text="Own worktree." at={322} dur={84} size={130} align="left" y={300} />
      <Slam text="Main never stops." at={492} dur={100} size={130} align="left" y={300} accent={C.green} />
    </Background>
  );
};

const CHANGELOG = (start: number) => (
  <>
    <L at={start}>
      <span style={{ color: C.dim }}>❯ </span>explore: draft the changelog
    </L>
    <L at={start + 20}>
      <Dot />
      Reading commits since v0.1.0 (plan mode).
    </L>
    <L at={start + 45}>
      <Dot />
      Proposed: Fixed SSO 500 · retry webhooks
    </L>
  </>
);

const CODEX = (start: number) => (
  <>
    <L at={start} color={C.dim}>
      Your only task: add a health check
    </L>
    <L at={start + 20}>• Added GET /healthz in server/health.ts</L>
    <L at={start + 45}>
      • Tests: <span style={{ color: C.green }}>3 passed</span>
    </L>
  </>
);

/** 1500–1860: two more forks, then the camera swings round and the panes separate like branches. */
export const Branches: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n3 = spring({ frame: frame - 30, fps, config: { damping: 18 } });
  const n4 = spring({ frame: frame - 60, fps, config: { damping: 18 } });
  const count = 1 + n3 + n4;
  const h = (H - M * (count - 1)) / count;
  const x = M * 2 + HALF;
  const sep = kf(frame, [[130, 0], [210, 150]], ease.out);
  const cam = {
    z: kf(frame, [[0, -40], [130, -40], [215, -420], [360, -520]]),
    rx: kf(frame, [[0, 5], [130, 2], [215, 14], [360, 16]]),
    ry: kf(frame, [[0, -7], [130, 0], [215, 36], [360, 46]]),
  };
  const focus = frame >= 60 ? 4 : frame >= 30 ? 3 : 2;
  return (
    <Background glow={C.blue}>
      <Dust />
      <Stage {...cam} sh={shake(frame, [30, 60], 8)}>
        <PitWindow
          open3d
          pressed={(frame >= 28 && frame < 36) || (frame >= 58 && frame < 66) ? 'F2' : undefined}
          tabs={[
            { label: 'main', glyph: '●', color: C.green },
            { label: 'fix-the-500', glyph: '○', color: C.dim, focused: focus === 2 },
            ...(frame >= 30 ? [{ label: 'draft-the-changelog', glyph: '●', color: C.green, focused: focus === 3 }] : []),
            ...(frame >= 60 ? [{ label: 'add-a-health-check', glyph: '●', color: C.green, focused: focus === 4 }] : []),
          ]}
        >
          <Pane segs={mainSegs('working')} cost="$0.44" style={{ left: M, top: TOP, width: HALF, height: H }}>
            <MainContent base={600} />
          </Pane>
          <Pane
            focused={focus === 2}
            segs={forkSegs('fix-the-500', '○ idle', C.dim, focus === 2)}
            cost="$0.09"
            style={{ left: x, top: TOP, width: HALF, height: h, transform: `translateZ(${sep}px)`, boxShadow: sep ? `0 0 50px ${C.accent}55` : undefined }}
          >
            <ForkContent start={0} still />
          </Pane>
          {frame >= 30 && (
            <Pane
              focused={focus === 3}
              segs={forkSegs('draft-the-changelog', '● working', C.green, focus === 3, 'fork of main', 3)}
              style={{ left: x, top: TOP + h + M, width: HALF, height: h, opacity: n3, transform: `translateZ(${sep * 2}px)`, boxShadow: sep ? `0 0 50px ${C.blue}55` : undefined }}
            >
              {CHANGELOG(40)}
            </Pane>
          )}
          {frame >= 60 && (
            <Pane
              focused={focus === 4}
              segs={forkSegs('add-a-health-check', '● running', C.green, focus === 4, 'codex · fork of main', 4)}
              style={{ left: x, top: TOP + 2 * (h + M), width: HALF, height: h, opacity: n4, transform: `translateZ(${sep * 3}px)`, boxShadow: sep ? `0 0 50px ${C.green}55` : undefined }}
            >
              {CODEX(70)}
            </Pane>
          )}
        </PitWindow>
      </Stage>
      <Flash at={30} len={10} color={C.accent} peak={0.15} />
      <Flash at={60} len={10} color={C.accent} peak={0.15} />
      <Slam text="Every session." at={150} dur={86} size={150} y={320} />
      <Slam text="One terminal." at={240} dur={115} size={150} y={320} accent={C.accent} />
    </Background>
  );
};

/** 1860–2220: F3, the fork flies home, a shockwave, main learns what changed. */
export const Merge: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - 68, fps, config: { damping: 15 } });
  const flight = interpolate(frame, [120, 150], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease.in });
  const landed = frame >= 150;
  const grow = spring({ frame: frame - 150, fps, config: { damping: 16, stiffness: 120 } });
  const mainW = landed ? HALF + (FULL - HALF) * grow : HALF;
  const forkLeft = WIN.left + M * 2 + HALF;
  const forkTop = WIN.top + 38 + TOP;
  const target = { x: WIN.left + M + HALF / 2, y: forkTop + H / 2 };
  const flyPos = (p: number) => ({
    x: forkLeft + HALF / 2 + (target.x - forkLeft - HALF / 2) * p,
    y: forkTop + H / 2 - Math.sin(p * Math.PI) * 140,
    s: 1 - p * 0.85,
    r: -p * 10,
  });
  const ring = interpolate(frame, [150, 200], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease.out });
  const cam = {
    z: kf(frame, [[0, -500], [40, -60], [150, -60], [160, -20], [360, -160]], ease.outExpo),
    rx: kf(frame, [[0, 12], [40, 3], [360, 6]]),
    ry: kf(frame, [[0, 30], [40, 4], [360, -6]]),
  };
  return (
    <Background glow={C.green}>
      <Dust />
      <Stage {...cam} sh={shake(frame, [60, 150], 18)}>
        <PitWindow
          pressed={frame >= 60 && frame < 72 ? 'F3' : undefined}
          tabs={[
            { label: 'main', glyph: '●', color: C.green, focused: landed },
            ...(landed ? [] : [{ label: 'fix-the-500', glyph: '○', color: C.dim, focused: true }]),
          ]}
          message={landed ? { text: '✓ merged fix-the-500 · merge commit · main was told', color: C.green } : undefined}
        >
          <Pane focused={landed} segs={mainSegs('working', landed)} cost="$0.47" style={{ left: M, top: TOP, width: mainW, height: H }}>
            <MainContent
              base={960}
              extra={
                <>
                  <L> </L>
                  <L at={175} color={C.blue}>
                    › pitstop-update: fix-the-500 was merged · changed auth/sso.ts · re-run: npm test -- auth
                  </L>
                  <L at={175}> </L>
                  <L at={225}>
                    <Dot />
                    Noted: the SSO fix is in. I&apos;ll re-run the auth tests after the suite.
                  </L>
                </>
              }
            />
          </Pane>
          {frame < 120 && (
            <Pane focused segs={forkSegs('fix-the-500', '○ idle', C.dim, true)} cost="$0.09" style={{ left: M * 2 + HALF, top: TOP, width: HALF, height: H }}>
              <ForkContent start={0} still />
            </Pane>
          )}
          {frame >= 68 && frame < 120 && (
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '42%',
                width: 700,
                transform: `translate(-50%, -50%) scale(${0.8 + pop * 0.2})`,
                opacity: pop * interpolate(frame, [110, 120], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
                background: '#333',
                border: `2px solid ${C.accent}`,
                borderRadius: 12,
                padding: '26px 32px 20px',
                boxShadow: '0 30px 80px #000c',
                fontSize: 20,
                lineHeight: 1.7,
                color: C.text,
                zIndex: 20,
              }}
            >
              <div style={{ color: C.accent, fontWeight: 700, fontSize: 22, marginBottom: 8 }}>Merge fix-the-500?</div>
              <div>1 commit · auth/sso.ts</div>
              <div>
                Test gate <span style={{ color: C.green }}>✓ passed</span> · main is clean → <b>merge commit</b>
              </div>
              <div style={{ marginTop: 12, color: C.accent, fontWeight: 700 }}>
                <span style={{ background: frame >= 100 ? C.accent : 'transparent', color: frame >= 100 ? '#000' : C.accent, padding: '0 6px', borderRadius: 4 }}>
                  y yes
                </span>{' '}
                · n no
              </div>
            </div>
          )}
        </PitWindow>
      </Stage>
      {/* the fork flying home, with a trail */}
      {frame >= 120 && frame < 152 &&
        [0.32, 0.24, 0.16, 0.08, 0].map((lag, k) => {
          const p = Math.max(0, flight - lag);
          const pos = flyPos(p);
          return (
            <div
              key={k}
              style={{
                position: 'absolute',
                left: pos.x - HALF / 2,
                top: pos.y - H / 2,
                width: HALF,
                height: H,
                transform: `scale(${pos.s}) rotate(${pos.r}deg)`,
                opacity: k === 4 ? 1 : 0.12 + k * 0.08,
                border: `2px solid ${C.accent}`,
                borderRadius: 10,
                background: k === 4 ? C.term : `${C.accent}22`,
                boxShadow: `0 0 60px ${C.accent}`,
                filter: k === 4 ? `blur(${flight * 2}px)` : 'blur(6px)',
              }}
            />
          );
        })}
      {frame >= 150 && frame < 205 && (
        <div
          style={{
            position: 'absolute',
            left: target.x - 900 * ring,
            top: target.y - 900 * ring,
            width: 1800 * ring,
            height: 1800 * ring,
            borderRadius: '50%',
            border: `${6 * (1 - ring) + 1}px solid ${C.green}`,
            boxShadow: `0 0 80px ${C.green}, inset 0 0 80px ${C.green}55`,
            opacity: 1 - ring,
          }}
        />
      )}
      <Flash at={60} len={10} color={C.accent} peak={0.2} />
      <Flash at={150} len={20} color={C.green} peak={0.35} />
      <KeyCap label="F3" at={18} pressAt={60} hint="merge it back" />
      <Scrim on={between(frame, [[240, 350]])} />
      <Slam text="Code + context." at={240} dur={56} size={130} align="left" y={300} />
      <Slam text="Merged back." at={298} dur={62} size={130} align="left" y={300} accent={C.green} />
    </Background>
  );
};
