import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({ plugins: [react()], base: './', resolve: { alias: { '@matrix-os/brand': fileURLToPath(new URL('../../../packages/brand/src/index.ts', import.meta.url)) } }, server: { host: '127.0.0.1', port: 3036, strictPort: true }, build: { outDir: 'dist' } });
