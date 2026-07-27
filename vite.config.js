import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/pdfjs-dist') || id.includes('node_modules/react-pdf')) return 'pdfjs';
          if (id.includes('node_modules/katex') || id.includes('node_modules/mathjs')) return 'math';
          if (id.includes('node_modules/plotly.js-dist-min')) return 'plotly';
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
  server: {
    host: true,
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
