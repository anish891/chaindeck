// Build for the owner-only paper trading app. The output goes to public/paper (committed, so the deploy needs no build
// step): `npm run build:paper` regenerates it and CI checks the committed copy is current.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: import.meta.dirname,
  base: '/paper/',
  publicDir: false, // /css/styles.css and friends belong to the dashboard and are linked by absolute path
  plugins: [react()],
  build: {
    outDir: '../public/paper',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    modulePreload: { polyfill: false } // no inline helper: the page's CSP forbids inline scripts
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/css': 'http://localhost:3000', '/js': 'http://localhost:3000', '/fonts': 'http://localhost:3000' }
  }
});
