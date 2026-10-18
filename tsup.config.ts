import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/cli.ts'], format: ['esm'], target: 'node24', platform: 'node', removeNodeProtocol: false, clean: true, sourcemap: false, splitting: false, banner: { js: '#!/usr/bin/env node' } });
