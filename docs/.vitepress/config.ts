import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '基金宝',
  description: '开源的基金实时估值查看工具',
  lang: 'zh-CN',
  
  // GitHub Pages 部署配置
  base: '/fund-app/',
  
  head: [
    ['link', { rel: 'icon', href: '/fund-app/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#ff6b35' }],
    ['meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }],
  ],
  
  themeConfig: {
    logo: '/logo.svg',
    
    nav: [
      { text: '首页', link: '/' },
      { text: '功能介绍', link: '/features' },
      { text: '下载安装', link: '/download' },
      { text: '更新日志', link: '/changelog' },
    ],
    
    sidebar: [
      {
        text: '开始使用',
        items: [
          { text: '介绍', link: '/guide/' },
          { text: '快速开始', link: '/guide/getting-started' },
          { text: '功能说明', link: '/guide/features' },
        ]
      },
      {
        text: '开发者',
        items: [
          { text: '本地开发', link: '/dev/setup' },
          { text: '项目结构', link: '/dev/structure' },
          { text: '贡献指南', link: '/dev/contributing' },
        ]
      }
    ],
    
    socialLinks: [
      { icon: 'github', link: 'https://github.com/xiriovo/fund-app' }
    ],
    
    footer: {
      message: '基于 MIT 协议开源',
      copyright: 'Copyright © 2026'
    },
    
    search: {
      provider: 'local'
    },
    
    outline: {
      label: '页面导航'
    },
    
    docFooter: {
      prev: '上一页',
      next: '下一页'
    },
    
    lastUpdated: {
      text: '最后更新于'
    }
  }
})
