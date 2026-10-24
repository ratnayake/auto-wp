#!/usr/bin/env node
// Source runs as TypeScript directly (no build step); tsx provides the loader.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/main.ts');
await main(process.argv.slice(2));
