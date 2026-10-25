import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'updater', include: ['test/**/*.test.ts'] } });
