import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

// The same palette as pit's own UI (xterm 256-colour values).
export const C = {
  bg: '#07090d',
  bg2: '#0e1118',
  term: '#1c1c1c',
  termBar: '#262626',
  frame: '#585858',
  text: '#e4e4e4',
  dim: '#8a8a8a',
  faint: '#4e4e4e',
  accent: '#ffaf5f',
  accentDeep: '#ff8700',
  blue: '#87afd7',
  green: '#87d787',
  yellow: '#d7af00',
  red: '#ff5f5f',
  button: '#444444',
  quit: '#5f0000',
};

export const FONT = {
  sans: 'Inter, system-ui, sans-serif',
  mono: '"JetBrains Mono", "DejaVu Sans Mono", monospace',
};

for (const w of ['400', '600', '800'])
  loadFont({ family: 'Inter', url: staticFile(`fonts/inter-${w}.woff2`), weight: w });
for (const w of ['400', '700'])
  loadFont({ family: 'JetBrains Mono', url: staticFile(`fonts/mono-${w}.woff2`), weight: w });

export const FPS = 60;
export const sec = (s: number) => Math.round(s * FPS);
