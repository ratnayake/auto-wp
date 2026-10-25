import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'config', include: ['test/**/*.test.ts'] } });
