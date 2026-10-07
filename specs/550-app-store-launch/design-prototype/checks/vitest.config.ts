import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    react: fileURLToPath(new URL('../../../../node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('../../../../node_modules/react-dom', import.meta.url)),
  } },
  test: { environment: 'jsdom', include: ['checks/*.test.tsx'], maxWorkers: 1 },
});
