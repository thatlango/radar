import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  base: '/app-ui/',
  build: {
    outDir: '../public/app-ui',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
});
