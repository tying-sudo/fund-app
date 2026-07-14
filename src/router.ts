// [WHY] 配置 Vue Router，定义页面路由
// [WHAT] 主要页面：持仓（默认）、行情、自选、分析、搜索、详情、交易记录

import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior() {
    return { top: 0 }
  },
  routes: [
    {
      path: '/',
      name: 'holding',
      component: () => import('@/views/Holding.vue'),
      meta: { title: '持仓' }
    },
        {
      path: '/market',
      name: 'market',
      component: () => import('@/views/Market.vue'),
      meta: { title: '行情' }
    },
    {
      path: '/market-more',
      name: 'marketMore',
      component: () => import('@/views/MarketMore.vue'),
      meta: { title: '行情详情' }
    },
    {
      path: '/home',
      name: 'home',
      component: () => import('@/views/Home.vue'),
      meta: { title: '自选' }
    },
    {
      path: '/analysis',
      name: 'analysis',
      component: () => import('@/views/Analysis.vue'),
      meta: { title: '分析' }
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('@/views/Search.vue'),
      meta: { title: '搜索' }
    },
    {
      path: '/detail/:code',
      name: 'detail',
      component: () => import('@/views/Detail.vue'),
      meta: { title: '基金详情' }
    },
    {
      path: '/trades',
      name: 'trades',
      component: () => import('@/views/TradeHistory.vue'),
      meta: { title: '交易记录' }
    },
    {
      path: '/compare',
      name: 'compare',
      component: () => import('@/views/Compare.vue'),
      meta: { title: '基金对比' }
    },
    {
      path: '/calculator',
      name: 'calculator',
      component: () => import('@/views/Calculator.vue'),
      meta: { title: '定投计算器' }
    },
    {
      path: '/manager/:code',
      name: 'manager',
      component: () => import('@/views/Manager.vue'),
      meta: { title: '基金经理' }
    },
    {
      path: '/manager-rank',
      name: 'managerRank',
      component: () => import('@/views/ManagerRank.vue'),
      meta: { title: '经理排行' }
    },
    {
      path: '/backtest',
      name: 'backtest',
      component: () => import('@/views/Backtest.vue'),
      meta: { title: '回测模拟' }
    },
    {
      path: '/filter',
      name: 'filter',
      component: () => import('@/views/Filter.vue'),
      meta: { title: '基金筛选' }
    },
    {
      path: '/alerts',
      name: 'alerts',
      component: () => import('@/views/Alerts.vue'),
      meta: { title: '智能提醒' }
    },
    {
      path: '/report',
      name: 'report',
      component: () => import('@/views/Report.vue'),
      meta: { title: '收益报告' }
    },
    {
      path: '/calendar',
      name: 'calendar',
      component: () => import('@/views/Calendar.vue'),
      meta: { title: '投资日历' }
    }
  ]
})

export default router
