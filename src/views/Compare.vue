<script setup lang="ts">
// [WHY] 基金对比页 - 对比多个基金的历史收益和风险指标
// [WHAT] 支持选择2-4个基金进行对比，展示收益率、波动率、夏普比率等
// [HOW] 使用 Canvas 绘制多基金走势对比图

import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useFundStore } from '@/stores/fund'
import { useThemeStore } from '@/stores/theme'
import { searchFund } from '@/api/fund'
import { fetchNetValueHistoryFast } from '@/api/fundFast'
import { showToast } from 'vant'
import type { FundInfo } from '@/types/fund'

const router = useRouter()
const fundStore = useFundStore()
const themeStore = useThemeStore()

// ========== 选中的基金 ==========
interface CompareFund {
  code: string
  name: string
  color: string
  data: { time: string; value: number }[]
  stats: {
    currentValue: number
    change1m: number
    change3m: number
    change6m: number
    change1y: number
    maxDrawdown: number   // 最大回撤
    volatility: number    // 波动率
    sharpe: number        // 夏普比率（简化版）
  }
}

const selectedFunds = ref<CompareFund[]>([])
const isLoading = ref(false)

// [WHAT] 预设颜色列表
const fundColors = ['#f7931a', '#1989fa', '#07c160', '#ee0a24']

// ========== 搜索相关 ==========
const showSearchPopup = ref(false)
const searchKeyword = ref('')
const searchResults = ref<FundInfo[]>([])
const isSearching = ref(false)

let searchTimer: ReturnType<typeof setTimeout> | null = null

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  if (!searchKeyword.value.trim()) {
    searchResults.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    isSearching.value = true
    try {
      searchResults.value = await searchFund(searchKeyword.value, 15)
    } catch {
      showToast('搜索失败')
    } finally {
      isSearching.value = false
    }
  }, 300)
}

// [WHAT] 添加基金到对比
async function addFund(fund: FundInfo) {
  if (selectedFunds.value.length >= 4) {
    showToast('最多对比4个基金')
    return
  }
  if (selectedFunds.value.some(f => f.code === fund.code)) {
    showToast('该基金已添加')
    return
  }

  showSearchPopup.value = false
  searchKeyword.value = ''
  searchResults.value = []

  isLoading.value = true
  try {
    // [WHAT] 获取历史数据
    const history = await fetchNetValueHistoryFast(fund.code, 365)
    
    if (history.length === 0) {
      showToast('无法获取该基金数据')
      return
    }

    // [WHAT] 转换数据格式
    const chartData = history.map(h => ({ time: h.date, value: h.netValue }))
    
    // [WHAT] 计算统计指标
    const stats = calculateStats(chartData)
    
    selectedFunds.value.push({
      code: fund.code,
      name: fund.name,
      color: fundColors[selectedFunds.value.length] || '#999',
      data: chartData,
      stats
    })

    await nextTick()
    drawChart()
  } catch (err) {
    console.error('添加基金失败:', err)
    showToast('获取数据失败')
  } finally {
    isLoading.value = false
  }
}

// [WHAT] 移除基金
function removeFund(code: string) {
  selectedFunds.value = selectedFunds.value.filter(f => f.code !== code)
  // [WHY] 重新分配颜色
  selectedFunds.value.forEach((f, i) => {
    f.color = fundColors[i] || '#999'
  })
  nextTick(drawChart)
}

// [WHAT] 从自选快速添加
function addFromWatchlist(item: { code: string; name: string }) {
  addFund({ code: item.code, name: item.name, type: '', pinyin: '' })
}

// ========== 统计计算 ==========
function calculateStats(data: { time: string; value: number }[]) {
  if (data.length < 2) {
    return { currentValue: 0, change1m: 0, change3m: 0, change6m: 0, change1y: 0, maxDrawdown: 0, volatility: 0, sharpe: 0 }
  }

  // [WHY] 数据按时间降序排列（最新在前）
  const values = data.map(d => d.value)
  const currentValue = values[0] || 0

  // [WHAT] 计算各周期涨幅
  const getChangeByDays = (days: number) => {
    const idx = Math.min(days, values.length - 1)
    const oldValue = values[idx] || values[values.length - 1]
    return oldValue > 0 ? ((currentValue - oldValue) / oldValue) * 100 : 0
  }

  const change1m = getChangeByDays(22)  // 约1个月交易日
  const change3m = getChangeByDays(66)
  const change6m = getChangeByDays(132)
  const change1y = getChangeByDays(252)

  // [WHAT] 计算最大回撤
  // [HOW] 找到历史最高点到最低点的最大跌幅
  let maxDrawdown = 0
  let peak = values[values.length - 1] || 0
  for (let i = values.length - 2; i >= 0; i--) {
    if (values[i]! > peak) {
      peak = values[i]!
    }
    const drawdown = ((peak - values[i]!) / peak) * 100
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown
    }
  }

  // [WHAT] 计算波动率（年化标准差）
  // [HOW] 日收益率标准差 × sqrt(252)
  const returns: number[] = []
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i + 1]! > 0) {
      returns.push((values[i]! - values[i + 1]!) / values[i + 1]!)
    }
  }
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
  const dailyStd = Math.sqrt(variance)
  const volatility = dailyStd * Math.sqrt(252) * 100

  // [WHAT] 计算夏普比率（简化版，假设无风险利率2%）
  // [HOW] (年化收益率 - 无风险利率) / 波动率
  const riskFreeRate = 2
  const sharpe = volatility > 0 ? (change1y - riskFreeRate) / volatility : 0

  return { currentValue, change1m, change3m, change6m, change1y, maxDrawdown, volatility, sharpe }
}

// ========== 图表绘制 ==========
const canvasRef = ref<HTMLCanvasElement | null>(null)
const chartPeriod = ref<'1m' | '3m' | '6m' | '1y'>('3m')

const periodDays: Record<string, number> = {
  '1m': 22,
  '3m': 66,
  '6m': 132,
  '1y': 252
}

// [WHAT] 获取主题颜色
function getThemeColors() {
  const isDark = themeStore.actualTheme === 'dark'
  return {
    bg: isDark ? '#0b0e11' : '#ffffff',
    text: isDark ? '#848e9c' : '#666666',
    grid: isDark ? '#1e2329' : '#f0f0f0',
    axis: isDark ? '#2b3139' : '#e0e0e0'
  }
}

function drawChart() {
  const canvas = canvasRef.value
  if (!canvas || selectedFunds.value.length === 0) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const colors = getThemeColors()
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()

  if (rect.width === 0 || rect.height === 0) {
    setTimeout(drawChart, 50)
    return
  }

  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)

  const width = rect.width
  const height = rect.height
  const padding = { top: 20, right: 60, bottom: 30, left: 10 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom

  // [WHAT] 清空画布
  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, width, height)

  // [WHAT] 获取所有基金在当前周期的数据，并归一化为收益率
  const days = periodDays[chartPeriod.value] || 66
  const allSeries: { color: string; points: { x: number; y: number }[] }[] = []
  let minChange = 0
  let maxChange = 0

  for (const fund of selectedFunds.value) {
    const slicedData = fund.data.slice(0, Math.min(days, fund.data.length))
    if (slicedData.length < 2) continue

    const baseValue = slicedData[slicedData.length - 1]?.value || 1
    const changes = slicedData.map((d, i) => ({
      x: slicedData.length - 1 - i,
      y: ((d.value - baseValue) / baseValue) * 100
    }))

    for (const c of changes) {
      if (c.y < minChange) minChange = c.y
      if (c.y > maxChange) maxChange = c.y
    }

    allSeries.push({ color: fund.color, points: changes })
  }

  // [WHY] 确保Y轴范围对称或合理
  const yRange = Math.max(Math.abs(minChange), Math.abs(maxChange), 5)
  minChange = -yRange * 1.1
  maxChange = yRange * 1.1

  // [WHAT] 绘制网格
  ctx.strokeStyle = colors.grid
  ctx.lineWidth = 1
  const ySteps = 5
  for (let i = 0; i <= ySteps; i++) {
    const y = padding.top + (chartHeight / ySteps) * i
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(width - padding.right, y)
    ctx.stroke()
  }

  // [WHAT] 绘制0%基准线
  const zeroY = padding.top + chartHeight * (maxChange / (maxChange - minChange))
  ctx.strokeStyle = colors.axis
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(padding.left, zeroY)
  ctx.lineTo(width - padding.right, zeroY)
  ctx.stroke()
  ctx.setLineDash([])

  // [WHAT] 绘制Y轴标签
  ctx.fillStyle = colors.text
  ctx.font = '11px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  for (let i = 0; i <= ySteps; i++) {
    const y = padding.top + (chartHeight / ySteps) * i
    const value = maxChange - ((maxChange - minChange) / ySteps) * i
    ctx.fillText(`${value >= 0 ? '+' : ''}${value.toFixed(1)}%`, width - padding.right + 5, y + 4)
  }

  // [WHAT] 绘制各基金走势线
  const maxX = Math.max(...allSeries.map(s => Math.max(...s.points.map(p => p.x))), 1)

  for (const series of allSeries) {
    if (series.points.length < 2) continue

    ctx.strokeStyle = series.color
    ctx.lineWidth = 2
    ctx.beginPath()

    for (let i = 0; i < series.points.length; i++) {
      const p = series.points[i]!
      const x = padding.left + (p.x / maxX) * chartWidth
      const y = padding.top + ((maxChange - p.y) / (maxChange - minChange)) * chartHeight

      if (i === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }
    ctx.stroke()
  }
}

// [WHAT] 监听主题变化
watch(() => themeStore.actualTheme, () => {
  nextTick(drawChart)
})

// [WHAT] 监听周期变化
watch(chartPeriod, () => {
  nextTick(drawChart)
})

// ========== 生命周期 ==========
onMounted(() => {
  window.addEventListener('resize', drawChart)
})

onUnmounted(() => {
  window.removeEventListener('resize', drawChart)
})

function goBack() {
  router.back()
}

// [WHAT] 格式化百分比
function formatPct(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

// [WHAT] 获取涨跌颜色类
function getChangeClass(value: number): string {
  if (value > 0) return 'up'
  if (value < 0) return 'down'
  return 'flat'
}
</script>

<template>
  <div class="compare-page">
    <!-- 顶部导航 -->
    <van-nav-bar title="基金对比" left-arrow @click-left="goBack">
      <template #right>
        <van-icon 
          v-if="selectedFunds.length < 4" 
          name="add-o" 
          size="20" 
          @click="showSearchPopup = true" 
        />
      </template>
    </van-nav-bar>

    <!-- 已选基金标签 -->
    <div v-if="selectedFunds.length > 0" class="selected-funds">
      <div 
        v-for="fund in selectedFunds" 
        :key="fund.code" 
        class="fund-tag"
        :style="{ borderColor: fund.color }"
      >
        <span class="tag-dot" :style="{ background: fund.color }"></span>
        <span class="tag-name">{{ fund.name.slice(0, 6) }}</span>
        <van-icon name="cross" size="14" @click="removeFund(fund.code)" />
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="selectedFunds.length === 0 && !isLoading" class="empty-state">
      <van-empty description="选择2-4个基金进行对比">
        <van-button type="primary" round size="small" @click="showSearchPopup = true">
          添加基金
        </van-button>
      </van-empty>
      
      <!-- 快捷添加自选 -->
      <div v-if="fundStore.watchlist.length > 0" class="quick-add">
        <div class="quick-title">从自选添加</div>
        <div class="quick-list">
          <div 
            v-for="item in fundStore.watchlist.slice(0, 8)" 
            :key="item.code"
            class="quick-item"
            @click="addFromWatchlist(item)"
          >
            {{ item.name?.slice(0, 6) || item.code }}
          </div>
        </div>
      </div>
    </div>

    <!-- 图表区域 -->
    <div v-if="selectedFunds.length > 0" class="chart-section">
      <div class="chart-header">
        <span class="chart-title">收益率走势对比</span>
        <div class="period-tabs">
          <span 
            v-for="p in ['1m', '3m', '6m', '1y']" 
            :key="p"
            class="period-tab"
            :class="{ active: chartPeriod === p }"
            @click="chartPeriod = p as any"
          >
            {{ p === '1m' ? '1月' : p === '3m' ? '3月' : p === '6m' ? '6月' : '1年' }}
          </span>
        </div>
      </div>
      <div class="chart-container">
        <canvas ref="canvasRef"></canvas>
      </div>
    </div>

    <!-- 指标对比表格 -->
    <div v-if="selectedFunds.length > 0" class="stats-section">
      <div class="section-title">指标对比</div>
      
      <div class="stats-table">
        <!-- 表头 -->
        <div class="table-row header">
          <div class="table-cell name">指标</div>
          <div 
            v-for="fund in selectedFunds" 
            :key="fund.code" 
            class="table-cell value"
            :style="{ color: fund.color }"
          >
            {{ fund.name.slice(0, 4) }}
          </div>
        </div>
        
        <!-- 当前净值 -->
        <div class="table-row">
          <div class="table-cell name">当前净值</div>
          <div v-for="fund in selectedFunds" :key="fund.code" class="table-cell value">
            {{ fund.stats.currentValue.toFixed(4) }}
          </div>
        </div>
        
        <!-- 近1月 -->
        <div class="table-row">
          <div class="table-cell name">近1月</div>
          <div 
            v-for="fund in selectedFunds" 
            :key="fund.code" 
            class="table-cell value"
            :class="getChangeClass(fund.stats.change1m)"
          >
            {{ formatPct(fund.stats.change1m) }}
          </div>
        </div>
        
        <!-- 近3月 -->
        <div class="table-row">
          <div class="table-cell name">近3月</div>
          <div 
            v-for="fund in selectedFunds" 
            :key="fund.code" 
            class="table-cell value"
            :class="getChangeClass(fund.stats.change3m)"
          >
            {{ formatPct(fund.stats.change3m) }}
          </div>
        </div>
        
        <!-- 近6月 -->
        <div class="table-row">
          <div class="table-cell name">近6月</div>
          <div 
            v-for="fund in selectedFunds" 
            :key="fund.code" 
            class="table-cell value"
            :class="getChangeClass(fund.stats.change6m)"
          >
            {{ formatPct(fund.stats.change6m) }}
          </div>
        </div>
        
        <!-- 近1年 -->
        <div class="table-row">
          <div class="table-cell name">近1年</div>
          <div 
            v-for="fund in selectedFunds" 
            :key="fund.code" 
            class="table-cell value"
            :class="getChangeClass(fund.stats.change1y)"
          >
            {{ formatPct(fund.stats.change1y) }}
          </div>
        </div>
        
        <!-- 最大回撤 -->
        <div class="table-row">
          <div class="table-cell name">最大回撤</div>
          <div 
            v-for="fund in selectedFunds" 
            :key="fund.code" 
            class="table-cell value down"
          >
            -{{ fund.stats.maxDrawdown.toFixed(2) }}%
          </div>
        </div>
        
        <!-- 波动率 -->
        <div class="table-row">
          <div class="table-cell name">波动率</div>
          <div v-for="fund in selectedFunds" :key="fund.code" class="table-cell value">
            {{ fund.stats.volatility.toFixed(2) }}%
          </div>
        </div>
        
        <!-- 夏普比率 -->
        <div class="table-row">
          <div class="table-cell name">夏普比率</div>
          <div 
            v-for="fund in selectedFunds" 
            :key="fund.code" 
            class="table-cell value"
            :class="getChangeClass(fund.stats.sharpe)"
          >
            {{ fund.stats.sharpe.toFixed(2) }}
          </div>
        </div>
      </div>
      
      <div class="stats-note">
        <van-icon name="info-o" />
        <span>夏普比率越高表示风险调整后收益越好，最大回撤反映历史最大亏损幅度</span>
      </div>
    </div>

    <!-- 加载中 -->
    <van-loading v-if="isLoading" class="loading-overlay" vertical>加载中...</van-loading>

    <!-- 搜索弹窗 -->
    <van-popup v-model:show="showSearchPopup" position="bottom" round :style="{ height: '70%' }">
      <div class="search-popup">
        <div class="popup-header">
          <span>添加基金</span>
          <van-icon name="cross" @click="showSearchPopup = false" />
        </div>
        
        <van-search
          v-model="searchKeyword"
          placeholder="输入基金代码或名称"
          @input="onSearchInput"
        />
        
        <div class="search-results">
          <van-cell
            v-for="fund in searchResults"
            :key="fund.code"
            :title="fund.name"
            :label="fund.code"
            clickable
            @click="addFund(fund)"
          >
            <template #right-icon>
              <van-icon name="add-o" size="20" />
            </template>
          </van-cell>
          
          <van-empty v-if="searchKeyword && !isSearching && searchResults.length === 0" description="未找到基金" />
          <van-loading v-if="isSearching" class="search-loading" />
        </div>
        
        <!-- 自选基金快捷添加 -->
        <div v-if="!searchKeyword && fundStore.watchlist.length > 0" class="watchlist-quick">
          <div class="quick-header">从自选添加</div>
          <van-cell
            v-for="item in fundStore.watchlist"
            :key="item.code"
            :title="item.name || item.code"
            :label="item.code"
            clickable
            @click="addFund({ code: item.code, name: item.name || item.code, type: '', pinyin: '' })"
          >
            <template #right-icon>
              <van-tag v-if="selectedFunds.some(f => f.code === item.code)" type="success">已添加</van-tag>
              <van-icon v-else name="add-o" size="20" />
            </template>
          </van-cell>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.compare-page {
  min-height: 100vh;
  background: var(--bg-primary);
  padding-bottom: 20px;
  transition: background-color 0.3s;
}

/* 已选基金标签 */
.selected-funds {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
  background: var(--bg-secondary);
}

.fund-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-radius: 16px;
  border: 1px solid;
  font-size: 13px;
}

.tag-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.tag-name {
  color: var(--text-primary);
}

/* 空状态 */
.empty-state {
  padding: 40px 16px;
}

.quick-add {
  margin-top: 24px;
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 16px;
}

.quick-title {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.quick-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.quick-item {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-primary);
}

/* 图表区域 */
.chart-section {
  margin: 12px;
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.chart-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.period-tabs {
  display: flex;
  gap: 4px;
}

.period-tab {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 12px;
  cursor: pointer;
}

.period-tab.active {
  color: #fff;
  background: var(--color-primary);
}

.chart-container {
  height: 200px;
  padding: 8px;
}

.chart-container canvas {
  width: 100%;
  height: 100%;
}

/* 指标对比 */
.stats-section {
  margin: 12px;
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
}

.section-title {
  padding: 12px 16px;
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.stats-table {
  padding: 0 8px;
}

.table-row {
  display: flex;
  align-items: center;
  padding: 10px 8px;
  border-bottom: 1px solid var(--border-color);
}

.table-row.header {
  background: var(--bg-tertiary);
}

.table-row:last-child {
  border-bottom: none;
}

.table-cell {
  flex: 1;
  text-align: center;
  font-size: 13px;
}

.table-cell.name {
  flex: 0 0 70px;
  text-align: left;
  color: var(--text-secondary);
}

.table-cell.value {
  color: var(--text-primary);
  font-weight: 500;
}

.table-cell.up { color: var(--color-up); }
.table-cell.down { color: var(--color-down); }
.table-cell.flat { color: var(--text-secondary); }

.stats-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 12px 16px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
}

/* 加载 */
.loading-overlay {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 20px;
  background: var(--bg-secondary);
  border-radius: 12px;
}

/* 搜索弹窗 */
.search-popup {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}

.popup-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.search-results {
  flex: 1;
  overflow-y: auto;
}

.search-loading {
  padding: 40px 0;
  text-align: center;
}

.watchlist-quick {
  flex: 1;
  overflow-y: auto;
}

.quick-header {
  padding: 12px 16px;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
}
</style>
