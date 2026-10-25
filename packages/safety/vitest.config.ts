import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'safety', include: ['test/**/*.test.ts'] } });
