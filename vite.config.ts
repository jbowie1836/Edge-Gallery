import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 3000, allowedHosts: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
