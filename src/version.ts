import { createRequire } from 'node:module';

// Read from package.json (one level up from both src/ and dist/), so an update can't leave it stale.
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
