import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  publicDir: false,
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      // 玩家入口与管理入口分开打包：后台代码不能出现在玩家包里
      input: {
        main: path.resolve(import.meta.dirname, 'src/client/index.html'),
        admin: path.resolve(import.meta.dirname, 'src/client/admin.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
