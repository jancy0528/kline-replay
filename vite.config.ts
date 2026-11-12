import { defineConfig } from 'vite'

/**
 * 单一 base 配置项。
 * GitHub Pages 部署在 https://jancy0528.github.io/kline-replay/ ，
 * manifest 的 start_url / scope、Service Worker 与图标都用相对路径，
 * 因此改仓库名时只需改这一处。开发服务器同样在这个路径下提供页面。
 */
const BASE = '/kline-replay/'

export default defineConfig({
  base: BASE,
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
})
