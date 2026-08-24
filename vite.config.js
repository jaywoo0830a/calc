import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

// scanic ML 자산(ORT 런타임 .mjs/.wasm + 모델 .ort)을 dev에서도 원본 그대로 서빙
// Vite는 public/ 파일의 동적 import(?import)를 소스 변환하려다 실패하므로,
// 내부 미들웨어보다 먼저 등록해 변환 없이 스트리밍한다. (프로덕션은 nginx가 정적 서빙)
function serveScanicMlRaw() {
  const dir = join(rootDir, 'public', 'scanic-ml');
  const mime = {
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
    '.ort': 'application/octet-stream',
  };
  return {
    name: 'scanic-ml-raw',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/scanic-ml/')) return next();
        const pathname = decodeURIComponent(req.url.split('?')[0]);
        const name = normalize(pathname.slice('/scanic-ml/'.length));
        if (name.includes('..') || name.startsWith('/')) return next();
        const file = join(dir, name);
        try {
          if (!statSync(file).isFile()) return next();
        } catch {
          return next();
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [serveScanicMlRaw(), react()],
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
