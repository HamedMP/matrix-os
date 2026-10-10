import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '../../../desktop/node_modules/@tailwindcss/vite/dist/index.mjs';
import path from 'node:path';
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwind()],
  resolve: { dedupe: ['react', 'react-dom'], alias: {
    '@renderer': path.resolve(__dirname, '../../../desktop/src/renderer/src'),
    '@matrix-os/brand/themes': path.resolve(__dirname, '../../../packages/brand/src/themes'),
    '@matrix-os/ui/appearance': path.resolve(__dirname, '../../../packages/ui/src/appearance'),
  } },
  server: { host: '127.0.0.1', port: 5198, strictPort: true, fs: { allow: [path.resolve(__dirname, '../../..')] } },
});
