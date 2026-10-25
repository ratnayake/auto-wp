import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'report', include: ['test/**/*.test.ts'] } });
