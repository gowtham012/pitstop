import React from 'react';
import { Composition } from 'remotion';
import { FPS } from './theme';
import { DURATION, Launch } from './Video';

export const Root: React.FC = () => (
  <Composition id="Launch" component={Launch} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />
);
