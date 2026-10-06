import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { CameraMotionBlur } from '@remotion/motion-blur';
import { Break, Chaos, Vortex } from './v2/Chaos';
import { Branches, Hero, Merge } from './v2/Product';
import { Montage, Outro } from './v2/Finale';
import { Finish } from './lib/motion';

/**
 * The timeline, in frames at 60 fps. Every cut and slam lands on a beat of the
 * 120 BPM soundtrack (30 frames a beat); scripts/soundtrack.py uses the same times.
 */
export const SHOTS = [
  { from: 0, len: 600, C: Chaos },
  { from: 600, len: 120, C: Break },
  { from: 720, len: 180, C: Vortex, blur: true },
  { from: 900, len: 600, C: Hero },
  { from: 1500, len: 360, C: Branches },
  { from: 1860, len: 360, C: Merge, blur: true },
  { from: 2220, len: 360, C: Montage },
  { from: 2580, len: 480, C: Outro },
];

export const DURATION = 3060;

export const Launch: React.FC = () => (
  <AbsoluteFill style={{ background: '#000' }}>
    {SHOTS.map(({ from, len, C, blur }) => (
      <Sequence key={from} from={from} durationInFrames={len}>
        {blur ? (
          <CameraMotionBlur shutterAngle={180} samples={6}>
            <C />
          </CameraMotionBlur>
        ) : (
          <C />
        )}
      </Sequence>
    ))}
    <Finish />
    <Audio src={staticFile('soundtrack.wav')} />
  </AbsoluteFill>
);
