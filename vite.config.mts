import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(projectRoot, 'public'),
  publicDir: path.join(projectRoot, 'public-assets'),
  plugins: [
    preact(),
    {
      name: 'pocket-photos-admin-route',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/admin' || req.url === '/admin/') req.url = '/admin.html';
          next();
        });
      },
    },
  ],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: path.join(projectRoot, 'dist', 'public'),
    emptyOutDir: true,
    assetsInlineLimit: 4096,
    rolldownOptions: {
      input: {
        index: path.join(projectRoot, 'public', 'index.html'),
        admin: path.join(projectRoot, 'public', 'admin.html'),
      },
    },
  },
});
