// [WHY] 统一管理 API 地址配置
// [WHAT] 开发和生产环境都使用代理路径，避免 CORS 问题
// [NOTE] 修改此文件后需要重新构建

const isDev = import.meta.env.DEV
const isHostedWeb = typeof window !== 'undefined' && /(^|\.)tyingfund\.com$/i.test(window.location.hostname)

// [WHAT] 后端 API 基础地址
// 开发环境：空字符串（使用相对路径，通过 Vite 代理转发）
// 托管网页使用同源路径，兼容 tyingfund.com -> www.tyingfund.com 跳转；
// Capacitor's localhost WebView must use the canonical host directly. The apex
// domain redirects to www, and a cross-origin redirect makes Android fetch fail.
export const API_BASE_URL = isDev || isHostedWeb ? '' : 'https://www.tyingfund.com'

// [WHAT] 天天基金 API 代理路径
export const TIANTIAN_API_BASE = `${API_BASE_URL}/tiantian`

// [WHAT] 基金移动端 API 代理路径
export const FUND_MOB_API_BASE = `${API_BASE_URL}/api`

// [FIX] 始终使用代理，避免开发环境直接请求外部域名被 CORS 阻止
export const USE_PROXY = true

console.log(`[API Config] 环境: ${isDev ? 'development' : 'production'}, 基础地址: ${API_BASE_URL || 'localhost'}, 代理: ${USE_PROXY}`)
