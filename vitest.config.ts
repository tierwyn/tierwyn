import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Backstop: any test that leaks to the real Grok Bot CDP singleton hits a closed port
    // instead of the operator's live app (it would otherwise receive "Stop now" etc).
    env: { TIERWYN_GROKBOT_CDP_PORT: '1' },
  },
});
