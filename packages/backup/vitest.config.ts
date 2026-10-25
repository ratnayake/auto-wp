import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'backup', include: ['test/**/*.test.ts'] } });
