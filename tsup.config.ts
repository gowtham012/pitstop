import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts', hook: 'src/hook/entry.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['node-pty'],
});
