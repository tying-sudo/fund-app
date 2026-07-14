// [WHY] 交易记录状态管理，记录所有买入/卖出/分红/定投操作
// [WHAT] 提供交易记录的增删改查，支持按基金筛选和统计
// [DEPS] 依赖 localStorage 持久化数据

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { TradeRecord, TradeType } from '@/types/fund'

// [WHAT] localStorage 存储键
const STORAGE_KEY = 'fund_trades'

// [WHAT] 生成唯一 ID
function generateId(): string {
  return `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// [WHAT] 从 localStorage 读取数据
function loadTrades(): TradeRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

// [WHAT] 保存数据到 localStorage
function saveTrades(trades: TradeRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trades))
}

export const useTradeStore = defineStore('trade', () => {
  // ========== State ==========
  
  /** 所有交易记录 */
  const trades = ref<TradeRecord[]>(loadTrades())

  // ========== Getters ==========

  /** 按时间倒序排列的交易记录 */
  const sortedTrades = computed(() => {
    return [...trades.value].sort((a, b) => 
      new Date(b.date).getTime() - new Date(a.date).getTime()
    )
  })

  /** 获取指定基金的交易记录 */
  function getTradesByFund(code: string): TradeRecord[] {
    return sortedTrades.value.filter(t => t.code === code)
  }

  /** 计算指定基金的持仓成本和份额 */
  function calculateHolding(code: string) {
    const fundTrades = getTradesByFund(code)
    let totalShares = 0
    let totalCost = 0
    let totalDividend = 0

    for (const trade of fundTrades) {
      switch (trade.type) {
        case 'buy':
        case 'auto_invest':
          totalShares += trade.shares
          totalCost += trade.amount + trade.fee
          break
        case 'sell':
          // [WHY] 卖出时按比例减少成本
          const ratio = trade.shares / totalShares
          totalCost -= totalCost * ratio
          totalShares -= trade.shares
          break
        case 'dividend':
          totalDividend += trade.amount
          break
      }
    }

    return {
      shares: Math.max(0, totalShares),
      cost: Math.max(0, totalCost),
      avgCost: totalShares > 0 ? totalCost / totalShares : 0,
      dividend: totalDividend
    }
  }

  /** 交易统计 */
  const statistics = computed(() => {
    let totalBuy = 0
    let totalSell = 0
    let totalFee = 0
    let totalDividend = 0

    for (const trade of trades.value) {
      totalFee += trade.fee
      switch (trade.type) {
        case 'buy':
        case 'auto_invest':
          totalBuy += trade.amount
          break
        case 'sell':
          totalSell += trade.amount
          break
        case 'dividend':
          totalDividend += trade.amount
          break
      }
    }

    return {
      totalBuy,
      totalSell,
      totalFee,
      totalDividend,
      netInvest: totalBuy - totalSell
    }
  })

  // ========== Actions ==========

  /**
   * 添加交易记录
   */
  function addTrade(trade: Omit<TradeRecord, 'id' | 'createdAt'>): TradeRecord {
    const newTrade: TradeRecord = {
      ...trade,
      id: generateId(),
      createdAt: Date.now()
    }
    trades.value.push(newTrade)
    saveTrades(trades.value)
    return newTrade
  }

  /**
   * 快速添加买入记录
   */
  function addBuyTrade(params: {
    code: string
    name: string
    date: string
    amount: number
    netValue: number
    fee?: number
    remark?: string
  }): TradeRecord {
    const shares = params.amount / params.netValue
    return addTrade({
      code: params.code,
      name: params.name,
      type: 'buy',
      date: params.date,
      amount: params.amount,
      netValue: params.netValue,
      shares,
      fee: params.fee || 0,
      remark: params.remark
    })
  }

  /**
   * 快速添加卖出记录
   */
  function addSellTrade(params: {
    code: string
    name: string
    date: string
    shares: number
    netValue: number
    fee?: number
    remark?: string
  }): TradeRecord {
    const amount = params.shares * params.netValue
    return addTrade({
      code: params.code,
      name: params.name,
      type: 'sell',
      date: params.date,
      amount,
      netValue: params.netValue,
      shares: params.shares,
      fee: params.fee || 0,
      remark: params.remark
    })
  }

  /**
   * 添加分红记录
   */
  function addDividendTrade(params: {
    code: string
    name: string
    date: string
    amount: number
    remark?: string
  }): TradeRecord {
    return addTrade({
      code: params.code,
      name: params.name,
      type: 'dividend',
      date: params.date,
      amount: params.amount,
      netValue: 0,
      shares: 0,
      fee: 0,
      remark: params.remark
    })
  }

  /**
   * 更新交易记录
   */
  function updateTrade(id: string, updates: Partial<TradeRecord>): boolean {
    const index = trades.value.findIndex(t => t.id === id)
    if (index === -1) return false
    
    trades.value[index] = { ...trades.value[index], ...updates }
    saveTrades(trades.value)
    return true
  }

  /**
   * 删除交易记录
   */
  function deleteTrade(id: string): boolean {
    const index = trades.value.findIndex(t => t.id === id)
    if (index === -1) return false
    
    trades.value.splice(index, 1)
    saveTrades(trades.value)
    return true
  }

  /**
   * 删除指定基金的所有交易记录
   */
  function deleteTradesByFund(code: string): number {
    const before = trades.value.length
    trades.value = trades.value.filter(t => t.code !== code)
    saveTrades(trades.value)
    return before - trades.value.length
  }

  /**
   * 清空所有交易记录
   */
  function clearAllTrades(): void {
    trades.value = []
    saveTrades(trades.value)
  }

  return {
    // State
    trades,
    // Getters
    sortedTrades,
    statistics,
    // Actions
    getTradesByFund,
    calculateHolding,
    addTrade,
    addBuyTrade,
    addSellTrade,
    addDividendTrade,
    updateTrade,
    deleteTrade,
    deleteTradesByFund,
    clearAllTrades
  }
})
