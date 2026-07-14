<script setup lang="ts">
// [WHY] 回测功能 - 模拟历史某段时间投入的收益
// [WHAT] 支持一次性买入和定投两种模式，基于真实历史数据计算

import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { fetchNetValueHistoryFast } from '@/api/fundFast'
import type { NetValueRecord } from '@/types/fund'
import { useFundStore } from '@/stores/fund'
import { showToast } from 'vant'

const router = useRouter()
const fundStore = useFundStore()

// 表单数据
const fundCode = ref('')
const fundName = ref('')
const investMode = ref<'lump' | 'dip'>('lump')  // lump: 一次性买入, dip: 定投
const investAmount = ref('10000')
const startDate = ref('')
const endDate = ref('')
const dipFrequency = ref<'monthly' | 'weekly'>('monthly')

// 搜索相关
const showSearch = ref(false)
const searchList = computed(() => {
  return fundStore.watchlist.map(f => ({
    code: f.code,
    name: f.name || f.code
  }))
})

// 回测结果
const backtestResult = ref<{
  totalInvest: number      // 总投入
  finalValue: number       // 最终市值
  profit: number           // 收益金额
  profitRate: number       // 收益率
  maxDrawdown: number      // 最大回撤
  tradeCount: number       // 交易次数
  avgCost: number          // 平均成本
  historyData: { date: string; value: number; invested: number }[]  // 历史数据
} | null>(null)

const isCalculating = ref(false)
const chartCanvas = ref<HTMLCanvasElement | null>(null)

// [WHAT] 监听回测结果变化，绘制图表
watch(() => backtestResult.value, (result) => {
  if (result && result.historyData.length > 0) {
    nextTick(() => drawChart(result.historyData))
  }
}, { deep: true })

// [WHAT] 绘制收益走势图
function drawChart(data: { date: string; value: number; invested: number }[]) {
  const canvas = chartCanvas.value
  if (!canvas) return
  
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  
  // [WHAT] 设置 canvas 尺寸
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)
  
  const width = rect.width
  const height = rect.height
  const padding = { top: 20, right: 15, bottom: 30, left: 60 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  
  // [WHAT] 清空画布
  ctx.clearRect(0, 0, width, height)
  
  // [WHAT] 获取数据范围
  const values = data.map(d => d.value)
  const invested = data.map(d => d.invested)
  const allValues = [...values, ...invested]
  const minVal = Math.min(...allValues)
  const maxVal = Math.max(...allValues)
  const range = maxVal - minVal || 1
  
  // [WHAT] 获取主题颜色
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  const textColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'
  const upColor = '#e4393c'
  const investColor = '#999'
  
  // [WHAT] 绘制网格线
  ctx.strokeStyle = gridColor
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartHeight / 4) * i
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(width - padding.right, y)
    ctx.stroke()
  }
  
  // [WHAT] 绘制Y轴标签
  ctx.fillStyle = textColor
  ctx.font = '11px sans-serif'
  ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i++) {
    const val = maxVal - (range / 4) * i
    const y = padding.top + (chartHeight / 4) * i
    ctx.fillText(val >= 10000 ? (val/10000).toFixed(1) + '万' : val.toFixed(0), padding.left - 5, y + 4)
  }
  
  // [WHAT] 绘制投入线（灰色虚线）
  ctx.strokeStyle = investColor
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  for (let i = 0; i < data.length; i++) {
    const x = padding.left + (chartWidth / (data.length - 1)) * i
    const y = padding.top + chartHeight - ((data[i]!.invested - minVal) / range) * chartHeight
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.setLineDash([])
  
  // [WHAT] 绘制收益线
  const lastValue = data[data.length - 1]!.value
  const lastInvested = data[data.length - 1]!.invested
  const isProfit = lastValue >= lastInvested
  ctx.strokeStyle = isProfit ? upColor : '#1db82c'
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let i = 0; i < data.length; i++) {
    const x = padding.left + (chartWidth / (data.length - 1)) * i
    const y = padding.top + chartHeight - ((data[i]!.value - minVal) / range) * chartHeight
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
  
  // [WHAT] 填充收益区域
  ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight)
  ctx.lineTo(padding.left, padding.top + chartHeight)
  ctx.closePath()
  ctx.fillStyle = isProfit ? 'rgba(228, 57, 60, 0.1)' : 'rgba(29, 184, 44, 0.1)'
  ctx.fill()
  
  // [WHAT] 绘制X轴日期标签
  ctx.fillStyle = textColor
  ctx.textAlign = 'center'
  const labelCount = Math.min(5, data.length)
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.floor((data.length - 1) * i / (labelCount - 1))
    const x = padding.left + (chartWidth / (data.length - 1)) * idx
    const date = data[idx]!.date
    // 格式化日期：MM/DD
    const d = new Date(date)
    const label = `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}`
    ctx.fillText(label, x, height - padding.bottom + 15)
  }
  
  // [WHAT] 图例
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'left'
  // 收益线图例
  ctx.fillStyle = isProfit ? upColor : '#1db82c'
  ctx.fillRect(padding.left, height - 12, 12, 3)
  ctx.fillStyle = textColor
  ctx.fillText('市值', padding.left + 16, height - 8)
  // 投入线图例
  ctx.fillStyle = investColor
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(padding.left + 50, height - 10)
  ctx.lineTo(padding.left + 62, height - 10)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = textColor
  ctx.fillText('投入', padding.left + 66, height - 8)
}

// 选择基金
function selectFund(item: { code: string; name: string }) {
  fundCode.value = item.code
  fundName.value = item.name
  showSearch.value = false
}

// 执行回测
async function runBacktest() {
  if (!fundCode.value) {
    showToast('请选择基金')
    return
  }
  
  const amount = parseFloat(investAmount.value)
  if (isNaN(amount) || amount <= 0) {
    showToast('请输入有效的投资金额')
    return
  }
  
  if (!startDate.value || !endDate.value) {
    showToast('请选择时间范围')
    return
  }
  
  if (new Date(startDate.value) >= new Date(endDate.value)) {
    showToast('开始日期必须早于结束日期')
    return
  }
  
  isCalculating.value = true
  
  try {
    // [WHY] 获取足够长的历史数据（最多3年）
    const history = await fetchNetValueHistoryFast(fundCode.value, 1100)
    
    if (history.length < 10) {
      showToast('历史数据不足')
      return
    }
    
    // [WHAT] 筛选时间范围内的数据
    const startDateObj = new Date(startDate.value)
    const endDateObj = new Date(endDate.value)
    
    // [WHY] history 是按时间降序的（最新在前），需要反转
    const orderedHistory = [...history].reverse()
    
    const rangeData = orderedHistory.filter(item => {
      const d = new Date(item.date)
      return d >= startDateObj && d <= endDateObj
    })
    
    if (rangeData.length < 2) {
      showToast('所选时间范围数据不足')
      return
    }
    
    // [WHAT] 根据模式计算
    if (investMode.value === 'lump') {
      backtestResult.value = calculateLumpSum(rangeData, amount)
    } else {
      backtestResult.value = calculateDIP(rangeData, amount, dipFrequency.value)
    }
    
  } catch (err) {
    console.error('回测失败:', err)
    showToast('回测失败，请重试')
  } finally {
    isCalculating.value = false
  }
}

// [WHAT] 一次性买入计算
function calculateLumpSum(
  data: NetValueRecord[],
  amount: number
): typeof backtestResult.value {
  const firstNav = data[0]!.netValue
  const lastNav = data[data.length - 1]!.netValue
  
  // 买入份额
  const shares = amount / firstNav
  
  // 最终市值
  const finalValue = shares * lastNav
  
  // 计算最大回撤
  let maxDrawdown = 0
  let peak = firstNav
  for (const item of data) {
    if (item.netValue > peak) {
      peak = item.netValue
    }
    const drawdown = (peak - item.netValue) / peak * 100
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown
    }
  }
  
  // 构建历史数据
  const historyData = data.map(item => ({
    date: item.date,
    value: shares * item.netValue,
    invested: amount
  }))
  
  return {
    totalInvest: amount,
    finalValue,
    profit: finalValue - amount,
    profitRate: ((finalValue - amount) / amount) * 100,
    maxDrawdown,
    tradeCount: 1,
    avgCost: firstNav,
    historyData
  }
}

// [WHAT] 定投计算
function calculateDIP(
  data: NetValueRecord[],
  amountPerPeriod: number,
  frequency: 'monthly' | 'weekly'
): typeof backtestResult.value {
  // [WHY] 按频率筛选交易日
  const tradeRecords: { date: string; nav: number; amount: number; shares: number }[] = []
  
  let lastTradeMonth = -1
  let lastTradeWeek = -1
  
  for (const item of data) {
    const d = new Date(item.date)
    const month = d.getMonth()
    const week = Math.floor(d.getTime() / (7 * 24 * 60 * 60 * 1000))
    
    let shouldTrade = false
    
    if (frequency === 'monthly' && month !== lastTradeMonth) {
      shouldTrade = true
      lastTradeMonth = month
    } else if (frequency === 'weekly' && week !== lastTradeWeek) {
      shouldTrade = true
      lastTradeWeek = week
    }
    
    if (shouldTrade) {
      const shares = amountPerPeriod / item.netValue
      tradeRecords.push({
        date: item.date,
        nav: item.netValue,
        amount: amountPerPeriod,
        shares
      })
    }
  }
  
  if (tradeRecords.length === 0) {
    return null
  }
  
  // 计算总投入和总份额
  const totalInvest = tradeRecords.reduce((sum, r) => sum + r.amount, 0)
  const totalShares = tradeRecords.reduce((sum, r) => sum + r.shares, 0)
  
  // 平均成本
  const avgCost = totalInvest / totalShares
  
  // 最终市值
  const lastNav = data[data.length - 1]!.netValue
  const finalValue = totalShares * lastNav
  
  // 计算最大回撤（基于累计市值）
  let maxDrawdown = 0
  let peak = 0
  let accumulatedShares = 0
  let accumulatedInvest = 0
  let tradeIndex = 0
  
  const historyData: { date: string; value: number; invested: number }[] = []
  
  for (const item of data) {
    // 检查是否有交易
    if (tradeIndex < tradeRecords.length && 
        tradeRecords[tradeIndex]!.date === item.date) {
      accumulatedShares += tradeRecords[tradeIndex]!.shares
      accumulatedInvest += tradeRecords[tradeIndex]!.amount
      tradeIndex++
    }
    
    const currentValue = accumulatedShares * item.netValue
    
    historyData.push({
      date: item.date,
      value: currentValue,
      invested: accumulatedInvest
    })
    
    if (currentValue > peak) {
      peak = currentValue
    }
    if (peak > 0) {
      const drawdown = (peak - currentValue) / peak * 100
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown
      }
    }
  }
  
  return {
    totalInvest,
    finalValue,
    profit: finalValue - totalInvest,
    profitRate: ((finalValue - totalInvest) / totalInvest) * 100,
    maxDrawdown,
    tradeCount: tradeRecords.length,
    avgCost,
    historyData
  }
}

// 格式化数值
function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// 初始化日期默认值
const today = new Date()
const oneYearAgo = new Date(today)
oneYearAgo.setFullYear(today.getFullYear() - 1)

startDate.value = oneYearAgo.toISOString().split('T')[0]!
endDate.value = today.toISOString().split('T')[0]!
</script>

<template>
  <div class="backtest-page">
    <!-- 导航栏 -->
    <van-nav-bar 
      title="回测模拟" 
      left-arrow 
      @click-left="router.back()"
    />
    
    <!-- 设置区域 -->
    <div class="settings-section">
      <!-- 选择基金 -->
      <div class="field-item" @click="showSearch = true">
        <span class="field-label">选择基金</span>
        <div class="field-value clickable">
          <span v-if="fundCode">{{ fundName || fundCode }}</span>
          <span v-else class="placeholder">从自选中选择</span>
          <van-icon name="arrow" size="14" />
        </div>
      </div>
      
      <!-- 投资模式 -->
      <div class="field-item">
        <span class="field-label">投资模式</span>
        <div class="mode-switch">
          <span 
            class="mode-btn"
            :class="{ active: investMode === 'lump' }"
            @click="investMode = 'lump'"
          >一次性买入</span>
          <span 
            class="mode-btn"
            :class="{ active: investMode === 'dip' }"
            @click="investMode = 'dip'"
          >定期定投</span>
        </div>
      </div>
      
      <!-- 投资金额 -->
      <div class="field-item">
        <span class="field-label">
          {{ investMode === 'lump' ? '投资金额' : '每期金额' }}
        </span>
        <div class="input-wrapper">
          <span class="input-prefix">¥</span>
          <input 
            v-model="investAmount"
            type="number"
            placeholder="10000"
            class="amount-input"
          />
        </div>
      </div>
      
      <!-- 定投频率（定投模式） -->
      <div v-if="investMode === 'dip'" class="field-item">
        <span class="field-label">定投频率</span>
        <div class="mode-switch">
          <span 
            class="mode-btn"
            :class="{ active: dipFrequency === 'monthly' }"
            @click="dipFrequency = 'monthly'"
          >每月</span>
          <span 
            class="mode-btn"
            :class="{ active: dipFrequency === 'weekly' }"
            @click="dipFrequency = 'weekly'"
          >每周</span>
        </div>
      </div>
      
      <!-- 时间范围 -->
      <div class="field-item">
        <span class="field-label">开始日期</span>
        <input 
          v-model="startDate"
          type="date"
          class="date-input"
        />
      </div>
      
      <div class="field-item">
        <span class="field-label">结束日期</span>
        <input 
          v-model="endDate"
          type="date"
          class="date-input"
        />
      </div>
      
      <!-- 执行按钮 -->
      <van-button 
        type="primary" 
        block 
        :loading="isCalculating"
        @click="runBacktest"
      >
        开始回测
      </van-button>
    </div>
    
    <!-- 回测结果 -->
    <div v-if="backtestResult" class="result-section">
      <div class="result-header">
        <span class="result-title">回测结果</span>
        <span class="result-fund">{{ fundName || fundCode }}</span>
      </div>
      
      <!-- 核心指标 -->
      <div class="metrics-grid">
        <div class="metric-item">
          <span class="metric-label">总投入</span>
          <span class="metric-value">¥{{ formatMoney(backtestResult.totalInvest) }}</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">最终市值</span>
          <span class="metric-value">¥{{ formatMoney(backtestResult.finalValue) }}</span>
        </div>
        <div class="metric-item highlight">
          <span class="metric-label">收益金额</span>
          <span 
            class="metric-value" 
            :class="backtestResult.profit >= 0 ? 'up' : 'down'"
          >
            {{ backtestResult.profit >= 0 ? '+' : '' }}¥{{ formatMoney(backtestResult.profit) }}
          </span>
        </div>
        <div class="metric-item highlight">
          <span class="metric-label">收益率</span>
          <span 
            class="metric-value"
            :class="backtestResult.profitRate >= 0 ? 'up' : 'down'"
          >
            {{ backtestResult.profitRate >= 0 ? '+' : '' }}{{ backtestResult.profitRate.toFixed(2) }}%
          </span>
        </div>
        <div class="metric-item">
          <span class="metric-label">最大回撤</span>
          <span class="metric-value down">-{{ backtestResult.maxDrawdown.toFixed(2) }}%</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">交易次数</span>
          <span class="metric-value">{{ backtestResult.tradeCount }}次</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">平均成本</span>
          <span class="metric-value">{{ backtestResult.avgCost.toFixed(4) }}</span>
        </div>
      </div>
      
      <!-- 收益曲线（简化版） -->
      <div class="chart-section">
        <div class="chart-title">收益走势</div>
        <canvas ref="chartCanvas" class="chart-canvas"></canvas>
      </div>
    </div>
    
    <!-- 基金选择弹窗 -->
    <van-popup 
      v-model:show="showSearch" 
      position="bottom"
      :style="{ height: '60%' }"
      round
    >
      <div class="search-popup">
        <div class="popup-title">从自选中选择</div>
        <div v-if="searchList.length === 0" class="empty-tip">
          暂无自选基金，请先添加
        </div>
        <div v-else class="fund-list">
          <div 
            v-for="item in searchList" 
            :key="item.code"
            class="fund-item"
            @click="selectFund(item)"
          >
            <span class="fund-name">{{ item.name }}</span>
            <span class="fund-code">{{ item.code }}</span>
          </div>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.backtest-page {
  min-height: 100vh;
  background: var(--bg-primary);
  padding-bottom: env(safe-area-inset-bottom);
}

/* 设置区域 */
.settings-section {
  padding: 16px;
  background: var(--bg-secondary);
  margin: 12px;
  border-radius: 12px;
}

.field-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-color);
}

.field-item:last-of-type {
  border-bottom: none;
  margin-bottom: 12px;
}

.field-label {
  font-size: 15px;
  color: var(--text-primary);
}

.field-value {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  color: var(--text-secondary);
}

.field-value.clickable {
  cursor: pointer;
}

.placeholder {
  color: var(--text-muted);
}

/* 模式切换 */
.mode-switch {
  display: flex;
  gap: 8px;
}

.mode-btn {
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.mode-btn.active {
  color: #fff;
  background: var(--color-primary);
}

/* 输入框 */
.input-wrapper {
  display: flex;
  align-items: center;
  gap: 4px;
}

.input-prefix {
  font-size: 14px;
  color: var(--text-secondary);
}

.amount-input,
.date-input {
  padding: 8px 12px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: none;
  border-radius: 6px;
  text-align: right;
  width: 140px;
}

.date-input {
  width: 150px;
}

/* 结果区域 */
.result-section {
  margin: 12px;
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 16px;
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.result-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}

.result-fund {
  font-size: 13px;
  color: var(--text-secondary);
}

/* 指标网格 */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.metric-item {
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.metric-item.highlight {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
}

.metric-label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.metric-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  font-family: 'DIN Alternate', 'Roboto Mono', monospace;
}

.metric-value.up { color: var(--color-up); }
.metric-value.down { color: var(--color-down); }

/* 图表区域 */
.chart-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.chart-title {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.chart-canvas {
  width: 100%;
  height: 150px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

/* 搜索弹窗 */
.search-popup {
  padding: 16px;
}

.popup-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  text-align: center;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.empty-tip {
  text-align: center;
  padding: 40px 0;
  color: var(--text-secondary);
}

.fund-list {
  margin-top: 12px;
}

.fund-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
}

.fund-item:active {
  background: var(--bg-tertiary);
}

.fund-name {
  font-size: 15px;
  color: var(--text-primary);
}

.fund-code {
  font-size: 13px;
  color: var(--text-muted);
  font-family: 'Roboto Mono', monospace;
}

/* 移动端适配 */
@media (max-width: 400px) {
  .metrics-grid {
    grid-template-columns: 1fr;
  }
  
  .amount-input,
  .date-input {
    width: 120px;
  }
}
</style>
