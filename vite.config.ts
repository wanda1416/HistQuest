import path from 'node:path';
import { defineConfig } from 'vite';

// 服务端端口可能因占用而顺延，由 scripts/dev.mjs 注入
const serverPort = Number(process.env.HQ_SERVER_PORT) || 3000;

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
    // 固定 IPv4 回环：与 README 和 dev 脚本里打印的地址一致
    host: '127.0.0.1',
    port: 5173,
    // 端口被占用时直接报错：3000 的代理固定指向 5173，不能静默顺延
    strictPort: true,
    // 页面由 3000 代理提供，HMR 的 ws 让浏览器直连 5173
    hmr: { host: '127.0.0.1', clientPort: 5173 },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true,
      },
    },
  },
});
