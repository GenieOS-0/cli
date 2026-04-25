import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  // Bundle the SDK in (workspace dep that won't be on npm independently
  // until mailgenius is published; this also means a single binary
  // for the npx-only flow).
  noExternal: ['mailgenius'],
});
