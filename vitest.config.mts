import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./apps/mobile/src/', import.meta.url)),
      '@buddy/core': pkg('core'),
      '@buddy/algorithms': pkg('algorithms'),
      '@buddy/simulator': pkg('simulator'),
      '@buddy/devices': pkg('devices'),
      '@buddy/nightscout': pkg('nightscout'),
      '@buddy/tidepool': pkg('tidepool'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/mobile/src/**/__tests__/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
