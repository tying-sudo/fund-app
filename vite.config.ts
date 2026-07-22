import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { VantResolver } from '@vant/auto-import-resolver'
import { fileURLToPath, URL } from 'node:url'

// [WHY] 配置 Vite 构建工具，支持 Vue3 和 Vant 组件自动导入
// [WHAT] 使用 unplugin-vue-components 自动导入 Vant 组件，无需手动 import
export default defineConfig({
  plugins: [
    vue(),
    // [HOW] VantResolver 会自动识别 Vant 组件并导入对应的样式
    Components({
      resolvers: [VantResolver()],
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  // [WHAT] 定义全局常量，构建时注入
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // [WHAT] 代理配置：开发环境代理到本地后端，生产环境不需要
    proxy: {
      // [NOTE] 更具体的路径放在前面，确保优先匹配
      '/api/fundmobapi': {
        target: 'https://fundmobapi.eastmoney.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/fundmobapi/, ''),
        secure: true
      },
      // [FIX] 开发环境：后端 API 代理到生产环境(tyingfund.com -> Cloudflare Tunnel -> 10.0.10.20:3000)
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'https://tyingfund.com',
        changeOrigin: true,
        secure: true
      },
      // [FIX] 股票行情代理，避免直接请求 push2.eastmoney.com 被 CORS 阻止
      '/push2': {
        target: 'https://push2.eastmoney.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/push2/, ''),
        secure: true,
        logLevel: 'debug',
        headers: {
          'Referer': 'https://quote.eastmoney.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      },
      // [FIX] 基金重仓股数据代理
      '/fundf10': {
        target: 'https://fundf10.eastmoney.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/fundf10/, ''),
        secure: true,
        headers: {
          'Referer': 'https://quote.eastmoney.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      },
      // [FIX] 天天基金数据代理（基金列表、pingzhongdata、排行等）
      '/tiantian': {
        target: 'https://fund.eastmoney.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/tiantian/, ''),
        secure: true
      },
      // [FIX] 基金实时估值JSONP代理（关键！fundgz.1234567.com.cn 不是 fund.eastmoney.com）
      '/fundgz': {
        target: 'https://fundgz.1234567.com.cn',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/fundgz/, ''),
        secure: true
      },
      // [FIX] 东方财富 API 代理（历史净值等）
      '/eastmoney': {
        target: 'https://api.fund.eastmoney.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/eastmoney/, ''),
        secure: true
      },
      // [FIX] 基金新闻代理
      '/np': {
        target: 'https://np-listapi.eastmoney.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/np/, ''),
        secure: true
      },
      // [FIX] 新浪基金估值代理（通过后端转发到 sina.com.cn）
      '/sina': {
        target: 'https://tyingfund.com',
        changeOrigin: true,
        secure: true
      }
    }
  }
})
