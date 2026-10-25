import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'vulndb', include: ['test/**/*.test.ts'] } });
