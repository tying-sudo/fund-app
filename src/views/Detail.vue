<script setup lang="ts">
// [WHY] 基金详情页 - 专业交易所风格
// [WHAT] 深色主题、专业K线图、实时价格面板、成交量柱状图
// [HOW] Canvas绘制专业图表，秒级数据更新

import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useFundStore } from '@/stores/fund'
import { useHoldingStore } from '@/stores/holding'
import { useThemeStore } from '@/stores/theme'
import { fetchStockHoldings, detectShareClass } from '@/api/fund'
import { fetchFundEstimateFast, fetchStockQuotes, fetchRealDayChange, fetchNetValueHistoryFast } from '@/api/fundFast'
import { fetchGridValuations } from '@/api/gridNative'
import { fetchLatestValuationSettlement } from '@/api/valuationGrid'
import { fetchSimilarFunds, type PeriodReturnExt, type SimilarFund } from '@/api/tiantianApi'
import type { FundEstimate, StockHolding, FundShareClass, HoldingRecord } from '@/types/fund'
import { getJdFundLink } from '@/utils/format'
import { getBeijingDateString } from '@/utils/tradingDate'
import { getValuationComparisonState, hasUsableCurrentEstimate, isFundTradingHours, isRetainedMarketEstimate, shouldUseGridEstimateFallback } from '@/utils/holdingCalculator'
import { showToast } from 'vant'
import FundPerformancePanel from '@/components/FundPerformancePanel.vue'

const route = useRoute()
const router = useRouter()
const fundStore = useFundStore()
const holdingStore = useHoldingStore()
const themeStore = useThemeStore()

// [WHAT] 基金代码
const fundCode = computed(() => route.params.code as string)

// 数据状态
const fundInfo = ref<FundEstimate | null>(null)
const stockHoldings = ref<StockHolding[]>([])
const periodReturns = ref<PeriodReturnExt[]>([])
const similarFunds = ref<SimilarFund[]>([])
const isLoading = ref(true)
const shareClass = ref<FundShareClass>('A')

function derivePeriodReturnsFromHistory(history: Awaited<ReturnType<typeof fetchNetValueHistoryFast>>): PeriodReturnExt[] {
  const latest = history[0]
  if (!latest) return []
  const latestTime = new Date(`${latest.date}T00:00:00+08:00`).getTime()
  const definitions = [
    { period: 'Z', label: '近1周', days: 7 },
    { period: 'Y', label: '近1月', days: 30 },
    { period: '3Y', label: '近3月', days: 90 },
    { period: '6Y', label: '近6月', days: 180 },
    { period: '1N', label: '近1年', days: 365 }
  ]
  return definitions.flatMap(item => {
    const cutoff = latestTime - item.days * 24 * 60 * 60 * 1000
    const start = history.find(record => new Date(`${record.date}T00:00:00+08:00`).getTime() <= cutoff)
    if (!start || start.netValue <= 0) return []
    return [{
      period: item.period,
      label: item.label,
      fundReturn: ((latest.netValue - start.netValue) / start.netValue) * 100,
      avgReturn: 0,
      hs300Return: 0,
      rank: 0,
      totalCount: 0
    }]
  })
}

// [WHAT] 实时刷新
let refreshTimer: ReturnType<typeof setInterval> | null = null
const lastUpdateTime = ref('')

// [WHAT] 24小时模拟数据（基金用昨收和估值）
const high24h = ref(0)
const low24h = ref(0)

// [WHAT] 真实涨跌幅数据（盘后机构公布）
const realDayChange = ref<{ nav: number; changeRate: number; date: string } | null>(null)

function retainLatestRealDayChange(next: { nav: number; changeRate: number; date: string } | null) {
  if (!next) return
  if (!realDayChange.value || next.date >= realDayChange.value.date) realDayChange.value = next
}

async function hydrateDetailSettlement(code: string, base: FundEstimate | null) {
  if (!base) return
  // A same-day estimate is authoritative until today's official NAV arrives.
  // Do not let an older settled comparison overwrite it after the close.
  if (hasUsableCurrentEstimate(base)) return
  const settlement = await fetchLatestValuationSettlement(code)
  if (!settlement || fundCode.value !== code) return

  const previousNav = Number(base.dwjz)
  if (!Number.isFinite(previousNav) || previousNav <= 0) return
  const officialNav = base.source === 'market_snapshot' && Number(base.gsz) > 0
    ? Number(base.gsz)
    : previousNav * (1 + settlement.realChange / 100)
  const estimatedNav = previousNav * (1 + settlement.estimateChange / 100)

  retainLatestRealDayChange({ nav: officialNav, changeRate: settlement.realChange, date: settlement.date })
  fundInfo.value = {
    ...base,
    gsz: estimatedNav.toFixed(4),
    gszzl: settlement.estimateChange.toFixed(4),
    gztime: `${settlement.date} 15:00`,
    source: 'settlement_cache',
    realtime: false,
    stale: true
  }
}

onMounted(async () => {
  await loadFundData()
  startAutoRefresh()
})

// [WHY] 监听路由参数变化，同一组件内导航时重新加载数据
watch(fundCode, async (newCode, oldCode) => {
  if (newCode && newCode !== oldCode) {
    // [WHAT] 清空旧数据
    fundInfo.value = null
    stockHoldings.value = []
    periodReturns.value = []
    similarFunds.value = []
    isLoading.value = true
    
    // [WHAT] 重新加载数据
    await loadFundData()
  }
})

onUnmounted(() => {
  stopAutoRefresh()
})

// The backend caches live estimates for 20 seconds. Keep this timer alive so
// an overseas fund resumes automatically when its underlying market opens.
function startAutoRefresh() {
  refreshTimer = setInterval(async () => {
    const isOpen = isFundTradingHours(fundInfo.value?.name)
    if (!isOpen) return
    
    await refreshEstimate()
  }, 15000)
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

async function refreshEstimate() {
  try {
    // [WHAT] 并发刷新估值和真实涨跌幅
    const [estimate, realChange] = await Promise.all([
      fetchFundEstimateFast(fundCode.value),
      fetchRealDayChange(fundCode.value).catch(() => null)
    ])
    
    if (estimate) {
      const gsz = parseFloat(estimate.gsz) || 0
      
            // [WHAT] 更新最高最低（含昨收基准）
      const dwjz = parseFloat(estimate.dwjz) || 0
      if (gsz > 0) {
        const h = Math.max(gsz, dwjz)
        const l = Math.min(gsz, dwjz)
        if (high24h.value === 0 || h > high24h.value) high24h.value = h
        if (low24h.value === 0 || l < low24h.value) low24h.value = l
      }
      
      fundInfo.value = estimate
      void applyGridDetailEstimate(fundCode.value, estimate)
      const now = new Date()
      lastUpdateTime.value = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
    }
    
    // [WHAT] 更新真实涨跌幅
    if (realChange) {
      retainLatestRealDayChange(realChange)
    }
    void hydrateDetailSettlement(fundCode.value, estimate)
  } catch {
    // 静默失败
  }
}

async function applyGridDetailEstimate(code: string, base: FundEstimate) {
  // The grid only repairs a synthetic all-market NAV snapshot. A validated
  // same-day provider estimate (for example sina_ds2) is more authoritative.
  if (!shouldUseGridEstimateFallback(base.source) || base.valuationType === 'hybrid_qdii') return

  const gridItems = await fetchGridValuations([code]).catch(() => [])
  const grid = gridItems[0]
  const today = getBeijingDateString()
  const change = Number(grid?.estimation_change)

  // The all-market snapshot can mark a copied previous NAV as today's 0.00%
  // before the official NAV is published. The grid owns the frozen same-day
  // estimate during this settlement gap.
  if (base && grid?._source !== 'nav' && grid?._valuation_date === today && Number.isFinite(change)) {
    const previousNav = Number(base.dwjz)
    if (previousNav > 0) {
      const resolved: FundEstimate = {
        ...base,
        name: grid.fund_name || base.name,
        gsz: (previousNav * (1 + change / 100)).toFixed(4),
        gszzl: change.toFixed(4),
        gztime: `${today} ${grid._frozen ? '15:00' : '实时'}`
      }
      if (fundCode.value === code) fundInfo.value = resolved
      return
    }
  }
}

async function loadFundData() {
  isLoading.value = true
  
  try {
    // [FIX] 只等待估值数据，真实涨跌幅后台加载不阻塞页面
    const estimate = await fetchFundEstimateFast(fundCode.value).catch((err) => {
      console.warn('估值获取失败:', err)
      return null
    })

    console.log('估值数据:', estimate)
    fundInfo.value = estimate
    if (estimate) void applyGridDetailEstimate(fundCode.value, estimate)
    if (estimate) void hydrateDetailSettlement(fundCode.value, estimate)

    // [FIX] 真实涨跌幅后台加载，不阻塞页面渲染
    fetchRealDayChange(fundCode.value)
      .then(realChange => {
        if (realChange) {
          console.log('真实涨跌幅:', realChange)
          retainLatestRealDayChange(realChange)
        }
      })
      .catch((err) => {
        console.warn('真实涨跌幅获取失败:', err)
      })
    
        if (estimate) {
      shareClass.value = detectShareClass(fundCode.value, estimate.name)
      const gsz = parseFloat(estimate.gsz) || 0
      const dwjz = parseFloat(estimate.dwjz) || 0
      // [WHY] 今日最高/最低以昨收为基准，结合估值计算
      if (gsz > 0) {
        high24h.value = Math.max(gsz, dwjz)
        low24h.value = Math.min(gsz, dwjz)
      } else {
        high24h.value = dwjz
        low24h.value = dwjz
      }
        } else {
      // [FIX] 添加空值检查，防止fundCode为null时报错
      const code = fundCode.value || ''
      shareClass.value = code.endsWith('1') || code.endsWith('3') ? 'C' : 'A'
      console.warn('未获取到估值数据，可能是非交易时间或网络问题')
    }
    
    const now = new Date()
    lastUpdateTime.value = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
    
        // [WHY] 重仓股后台加载，不阻塞页面显示
    fetchStockHoldings(fundCode.value)
      .then(async holdings => {
        console.log('重仓股:', holdings)
        
        // [WHAT] 获取重仓股的实时涨跌幅（需带 marketPrefix 以区分沪深/港股/北交所）
        if (holdings.length > 0) {
          try {
            const quotes = await fetchStockQuotes(holdings)
            
            // [WHAT] 将涨跌幅数据合并到重仓股列表
            holdings.forEach(holding => {
              const quote = quotes.get(holding.stockCode)
              if (quote) {
                holding.dayChange = quote.changePercent
              }
            })
          } catch (err) {
            console.warn('获取股票涨跌幅失败:', err)
          }
        }
        
        stockHoldings.value = holdings
      })
      .catch(err => {
        console.warn('重仓股获取失败:', err)
      })
    
    // [WHY] 阶段涨幅后台加载
    const periodCode = fundCode.value
    fetchNetValueHistoryFast(periodCode, 400)
      .then(history => {
        if (fundCode.value === periodCode) periodReturns.value = derivePeriodReturnsFromHistory(history)
      })
      .catch(() => {})
    
    // [WHY] 同类基金后台加载
    fetchSimilarFunds(fundCode.value)
      .then(funds => {
        similarFunds.value = funds
      })
      .catch(() => {})
      
  } catch (err) {
    console.error('加载失败:', err)
    showToast('加载失败，请下拉刷新重试')
  } finally {
    isLoading.value = false
  }
}

// [WHAT] 获取股票涨跌幅样式类
function getStockChangeClass(stock: StockHolding): string {
  if (stock.dayChange === undefined || stock.dayChange === null) return ''
  if (stock.dayChange > 0) return 'up'
  if (stock.dayChange < 0) return 'down'
  return ''
}

// [WHAT] 格式化股票涨跌幅
function formatStockChange(change: number): string {
  if (change === undefined || change === null) return '--'
  const sign = change > 0 ? '+' : ''
  return `${sign}${change.toFixed(2)}%`
}

// [WHAT] 获取较上期变化样式类（与APK版本一致）
function getChangeFromLastClass(change: string): string {
  if (!change || change === '--') return ''
  if (change === '新增') return 'new-added'
  if (change === '持平') return 'unchanged'
  if (change.startsWith('+')) return 'up'
  if (change.startsWith('-')) return 'down'
  return ''
}

// [WHAT] 计算涨跌
const priceChange = computed(() => {
  if (!fundInfo.value || !hasDisplayEstimate.value) return 0
  const gsz = parseFloat(fundInfo.value.gsz) || 0
  const dwjz = parseFloat(fundInfo.value.dwjz) || 0
  return gsz - dwjz
})

// [WHAT] 涨跌幅：收盘后优先使用真实净值涨跌幅
const priceChangePercent = computed(() => {
  if (detailComparison.value.isCurrentReal && realDayChange.value) return realDayChange.value.changeRate
  return hasDisplayEstimate.value ? (parseFloat(fundInfo.value?.gszzl || '0') || 0) : 0
})

// [WHAT] 显示值：盘中显示估值，收盘后显示真实净值
const displayValue = computed(() => {
  if (detailComparison.value.isCurrentReal && realDayChange.value?.nav) return realDayChange.value.nav.toFixed(4)
  // A previous trading-day snapshot is displayed as the last NAV, not as a
  // current estimated value.
  return hasDisplayEstimate.value ? (fundInfo.value?.gsz || '--') : (fundInfo.value?.dwjz || '--')
})

const isUp = computed(() => priceChangePercent.value >= 0)
const showHoldingEditor = ref(false)
const detailHoldingForm = ref({ amount: '', profit: '', shares: '', costPrice: '', buyDate: '' })

function goBack() {
  router.back()
}

async function editHolding() {
  await holdingStore.initHoldings()
  const holding = holdingStore.getHoldingByCode(fundCode.value)
  if (!holding) {
    showToast('当前基金暂无持仓记录')
    return
  }
  detailHoldingForm.value = {
    amount: Number(holding.amount || 0).toFixed(2),
    profit: Number(holding.profit || 0).toFixed(2),
    shares: holding.shares ? String(holding.shares) : '',
    costPrice: holding.costPrice ? String(holding.costPrice) : '',
    buyDate: holding.buyDate || ''
  }
  showHoldingEditor.value = true
}

async function saveDetailHolding() {
  const holding = holdingStore.getHoldingByCode(fundCode.value)
  const amount = Number(detailHoldingForm.value.amount)
  if (!holding || !Number.isFinite(amount) || amount < 0) {
    showToast('请输入有效的持仓金额')
    return
  }
  const shares = Number(detailHoldingForm.value.shares)
  const costPrice = Number(detailHoldingForm.value.costPrice)
  const nextHolding: HoldingRecord = {
    ...holding,
    amount,
    shares: Number.isFinite(shares) && shares >= 0 ? shares : holding.shares,
    costPrice: Number.isFinite(costPrice) && costPrice > 0 ? costPrice : undefined,
    buyDate: detailHoldingForm.value.buyDate || holding.buyDate
  }
  try {
    await holdingStore.addOrUpdateHolding(nextHolding)
    showHoldingEditor.value = false
    showToast('持仓已保存')
  } catch (error) {
    console.error('[Detail] 保存持仓失败:', error)
    showToast('保存失败，请重试')
  }
}

// [WHAT] 跳转到同类基金详情
function goToSimilarFund(code: string) {
  if (!code) {
    showToast('基金代码无效')
    return
  }
  // [WHY] 如果点击的是当前基金，提示用户
  if (code === fundCode.value) {
    showToast('已在当前基金')
    return
  }
  router.push(`/detail/${code}`)
}

async function toggleWatchlist() {
  if (!fundInfo.value) return
  
  if (fundStore.isFundInWatchlist(fundCode.value)) {
    // 再次点击取消自选
    fundStore.removeFund(fundCode.value)
    showToast('已取消自选')
  } else {
    await fundStore.addFund(fundCode.value, fundInfo.value.name)
    showToast('添加成功')
  }
}

// [WHAT] 跳转基金经理页
function goToManager() {
  router.push(`/manager/${fundCode.value}`)
}

// [WHAT] 判断当前是否为交易时段（盘中）
const isTradingHours = computed(() => {
  return isFundTradingHours(fundInfo.value?.name)
})

const hasCurrentEstimate = computed(() => hasUsableCurrentEstimate(fundInfo.value))
const detailComparison = computed(() => getValuationComparisonState({
  realChange: realDayChange.value?.changeRate,
  realChangeDate: realDayChange.value?.date,
  estimateChange: fundInfo.value?.gszzl,
  estimateTime: fundInfo.value?.gztime,
  fundName: fundInfo.value?.name
}))
const hasCompletedEstimate = computed(() => detailComparison.value.hasActualDiff)
const hasDisplayEstimate = computed(() => hasCurrentEstimate.value || hasCompletedEstimate.value || (
  isRetainedMarketEstimate(fundInfo.value)
))
const hasCurrentOfficialNav = computed(() => {
  return detailComparison.value.isCurrentReal
})
// [WHAT] 状态标签文本
const statusTag = computed(() => {
  if (isTradingHours.value) return '估值中'
  return hasDisplayEstimate.value || hasCurrentOfficialNav.value ? '已更新' : '净值待公布'
})

// [WHAT] 状态标签样式类
const statusTagClass = computed(() => {
  return isTradingHours.value ? 'tag-trading' : hasDisplayEstimate.value || hasCurrentOfficialNav.value ? 'tag-updated' : 'tag-pending'
})

// [WHAT] 基金名称动态字体大小
const fundNameStyle = computed(() => {
  const name = fundInfo.value?.name || '基金'
  const len = name.length
  // 根据名称长度动态调整字体大小
  let fontSize = 17
  if (len > 6) fontSize = 15
  if (len > 8) fontSize = 14
  if (len > 10) fontSize = 13
  if (len > 12) fontSize = 12
  return { fontSize: `${fontSize}px` }
})

type DetailPanel = 'holdings' | 'trend' | 'analysis'
const activePanel = ref<DetailPanel>('trend')
const periodReturnsExpanded = ref(true)

const primaryStats = computed(() => [
  {
    label: hasCurrentEstimate.value ? '最新净值' : hasCompletedEstimate.value ? '昨日净值' : '最近净值',
    value: hasCurrentOfficialNav.value && realDayChange.value?.nav
      ? realDayChange.value.nav.toFixed(4)
      : (fundInfo.value?.dwjz || '--'),
    tone: ''
  },
  {
    label: realDayChange.value?.date === getBeijingDateString() ? '最新涨幅' : hasCompletedEstimate.value ? '昨日涨幅' : '涨跌幅',
    value: `${priceChangePercent.value > 0 ? '+' : ''}${priceChangePercent.value.toFixed(2)}%`,
    tone: priceChangePercent.value > 0 ? 'up' : priceChangePercent.value < 0 ? 'down' : ''
  },
  { label: hasCurrentEstimate.value ? '估算净值' : hasCompletedEstimate.value ? '昨日估值' : '当日估值', value: hasDisplayEstimate.value ? (fundInfo.value?.gsz || '--') : '--', tone: '' },
  {
    label: hasCurrentEstimate.value ? '估算涨幅' : hasCompletedEstimate.value ? '昨日估算涨幅' : '当日涨幅',
    value: hasDisplayEstimate.value && fundInfo.value?.gszzl ? `${Number(fundInfo.value.gszzl) > 0 ? '+' : ''}${Number(fundInfo.value.gszzl).toFixed(2)}%` : '--',
    tone: hasDisplayEstimate.value && Number(fundInfo.value?.gszzl) > 0 ? 'up' : hasDisplayEstimate.value && Number(fundInfo.value?.gszzl) < 0 ? 'down' : ''
  }
])

const visiblePeriods = computed(() => periodReturns.value.slice(0, 5))
</script>

<template>
  <div class="fund-detail-page">
    <header class="fund-detail-header">
      <button class="detail-icon-button" aria-label="返回" @click="goBack"><van-icon name="arrow-left" size="20" /></button>
      <h1>基金详情</h1>
      <div class="detail-header-actions">
        <button class="detail-icon-button" :aria-label="themeStore.actualTheme === 'dark' ? '切换亮色主题' : '切换暗色主题'" @click="themeStore.toggleTheme"><van-icon :name="themeStore.actualTheme === 'dark' ? 'bulb-o' : 'fire-o'" size="19" /></button>
        <button class="detail-icon-button" :aria-label="fundStore.isFundInWatchlist(fundCode) ? '取消自选' : '添加自选'" @click="toggleWatchlist"><van-icon :name="fundStore.isFundInWatchlist(fundCode) ? 'star' : 'star-o'" size="20" /></button>
      </div>
    </header>

    <main v-if="!isLoading" class="fund-detail-content">
      <section class="fund-identity">
        <div class="identity-main">
          <span class="fund-name" :style="fundNameStyle">{{ fundInfo?.name || '基金' }}</span>
          <button type="button" class="identity-edit-holding" aria-label="编辑持仓" @click="editHolding"><van-icon name="edit" size="13" /><span>编辑持仓</span></button>
          <span :class="['detail-status', statusTagClass]">{{ statusTag }}</span>
        </div>
        <div class="identity-meta">
          <a :href="getJdFundLink(fundCode)" class="fund-code-link">#{{ fundCode }}</a>
          <span class="identity-dot">·</span>
          <span>{{ shareClass }}类份额</span>
          <span class="identity-dot">·</span>
          <span>{{ fundInfo?.gztime || lastUpdateTime || '等待估值更新' }}</span>
        </div>
      </section>

      <section class="detail-stat-grid" aria-label="基金行情">
        <div v-for="item in primaryStats" :key="item.label" class="detail-stat">
          <span>{{ item.label }}</span>
          <strong :class="item.tone">{{ item.value }}</strong>
        </div>
      </section>

      <section v-if="visiblePeriods.length" class="detail-period-section" aria-label="阶段涨幅">
        <button type="button" class="period-collapse" :aria-expanded="periodReturnsExpanded" @click="periodReturnsExpanded = !periodReturnsExpanded">
          <span>{{ periodReturnsExpanded ? '收起' : '展开阶段涨幅' }}</span>
          <van-icon :name="periodReturnsExpanded ? 'arrow-up' : 'arrow-down'" />
        </button>
        <div v-show="periodReturnsExpanded" class="detail-period-grid">
          <div v-for="item in visiblePeriods" :key="item.period" class="detail-period">
            <span>{{ item.label }}</span>
            <strong :class="item.fundReturn >= 0 ? 'up' : 'down'">{{ item.fundReturn >= 0 ? '+' : '' }}{{ item.fundReturn.toFixed(2) }}%</strong>
          </div>
        </div>
      </section>

      <nav class="detail-tabs" aria-label="基金详情视图">
        <button :class="{ active: activePanel === 'holdings' }" @click="activePanel = 'holdings'">前10重仓</button>
        <button :class="{ active: activePanel === 'trend' }" @click="activePanel = 'trend'">业绩走势</button>
        <button :class="{ active: activePanel === 'analysis' }" @click="activePanel = 'analysis'">基金分析</button>
      </nav>

      <section v-if="activePanel === 'trend'" class="detail-panel detail-trend-panel">
        <FundPerformancePanel
          :fund-code="fundCode"
          :realtime-value="displayValue !== '--' ? parseFloat(displayValue) : 0"
          :realtime-change="priceChangePercent"
        />
      </section>

      <section v-else-if="activePanel === 'analysis'" class="detail-panel detail-analysis-panel" aria-label="基金分析">
        <h2>基金分析</h2>
        <p>功能开发中</p>
      </section>

      <section v-else class="detail-panel">
        <div v-if="stockHoldings.length" class="detail-holdings-table">
          <div class="detail-holding-row detail-holding-heading"><span>股票</span><span>涨跌幅</span><span>占比</span><span>季变</span></div>
          <div v-for="(stock, index) in stockHoldings.slice(0, 10)" :key="stock.stockCode" class="detail-holding-row">
            <div><b>{{ index + 1 }}. {{ stock.stockName }}</b><small>{{ stock.stockCode }} <i v-if="stock.sector" class="holding-sector">{{ stock.sector }}</i></small></div>
            <span :class="getStockChangeClass(stock)">{{ stock.dayChange !== undefined ? formatStockChange(stock.dayChange) : '--' }}</span>
            <span>{{ stock.holdingRatio.toFixed(2) }}%</span>
            <span :class="stock.quarterChange !== null && stock.quarterChange !== undefined ? (stock.quarterChange > 0 ? 'up' : stock.quarterChange < 0 ? 'down' : '') : ''">{{ stock.quarterChange !== null && stock.quarterChange !== undefined ? `${stock.quarterChange > 0 ? '+' : ''}${stock.quarterChange.toFixed(2)}%` : '--' }}</span>
          </div>
        </div>
        <div v-else class="detail-empty">暂无重仓股数据</div>
      </section>

    </main>

    <van-popup
      v-model:show="showHoldingEditor"
      position="bottom"
      round
      teleport="body"
      :style="{ maxWidth: '672px' }"
    >
      <form class="detail-holding-editor" @submit.prevent="saveDetailHolding">
        <header>
          <strong>编辑持仓</strong>
          <button type="button" aria-label="关闭编辑持仓" @click="showHoldingEditor = false"><van-icon name="cross" size="18" /></button>
        </header>
        <div class="detail-holding-editor-body">
          <van-field v-model="detailHoldingForm.amount" label="持仓金额" type="number" inputmode="decimal" />
          <van-field v-model="detailHoldingForm.profit" label="持有收益" type="number" inputmode="decimal" readonly />
          <van-field v-model="detailHoldingForm.shares" label="持有份额" type="number" inputmode="decimal" />
          <van-field v-model="detailHoldingForm.costPrice" label="成本单价" type="number" inputmode="decimal" />
          <van-field v-model="detailHoldingForm.buyDate" label="买入日期" type="date" />
        </div>
        <footer><van-button native-type="submit" type="primary" block>保存</van-button></footer>
      </form>
    </van-popup>

    <div v-if="isLoading" class="detail-loading"><van-loading vertical color="var(--color-primary)">加载中...</van-loading></div>
  </div>
</template>

<style scoped>
/* ========== 移动端APP适配 + 主题支持 ========== */
/* [WHY] 使用CSS变量实现黑白主题切换 */

.pro-detail-page {
  min-height: 100vh;
  min-height: -webkit-fill-available;
  background: var(--bg-primary);
  color: var(--text-primary);
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  transition: background-color 0.3s, color 0.3s;
}

/* 顶部导航 */
.pro-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  padding-top: max(12px, env(safe-area-inset-top));
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  position: sticky;
  top: 0;
  z-index: 100;
  transition: background-color 0.3s;
}

.header-left, .header-right {
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
  border-radius: 8px;
  transition: background 0.15s;
}

.header-left:active, .header-right:active {
  background: var(--bg-hover);
}

.header-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex: 1;
  justify-content: center;
  min-width: 0;
}

.pair-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pair-name {
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.pair-code {
  font-size: 11px;
  color: var(--text-secondary);
}

.pair-tag {
  padding: 3px 8px;
  font-size: 11px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.status-tag {
  padding: 2px 6px;
  font-size: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

.tag-updated {
  background: #ff9800;
  color: #fff;
}

.tag-trading {
  background: #2196f3;
  color: #fff;
}

.tag-pending {
  background: #64748b;
  color: #fff;
}

.theme-toggle {
  color: var(--color-primary);
}

.page-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 70px);
  background: var(--bg-primary);
}

/* 价格面板 */
.price-panel {
  padding: 16px;
  background: var(--bg-primary);
  border-bottom: 1px solid #1e2329;
}

.main-price {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
}

.price-value {
  /* [WHY] 使用vw实现响应式字体 */
  font-size: clamp(28px, 8vw, 36px);
  font-weight: 700;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  /* [WHY] 数字等宽对齐 */
  font-variant-numeric: tabular-nums;
}

.price-unit {
  font-size: 14px;
  color: var(--text-secondary);
}

/* [WHY] 红涨绿跌 */
.main-price.up .price-value { color: var(--color-up); }
.main-price.down .price-value { color: var(--color-down); }

.price-change {
  display: flex;
  gap: 12px;
  font-size: 15px;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
  margin-bottom: 16px;
}

/* [WHY] 红涨绿跌 */
.price-change.up { color: var(--color-up); }
.price-change.down { color: var(--color-down); }

/* 统计栏 */
.stats-bar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(70px, 1fr));
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.stat-value {
  font-size: 14px;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

/* [WHY] 红涨绿跌 */
.stat-value.up { color: var(--color-up); }
.stat-value.down { color: var(--color-down); }

/* 重仓股票区域 */
.holdings-section, .info-section {
  margin: 12px;
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color);
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-tip {
  font-size: 12px;
  color: var(--text-secondary);
}

.holdings-list {
  padding: 0 16px 16px;
}

.holdings-table-header {
  display: grid;
  grid-template-columns: 24px 3fr 1fr 1fr 1fr;
  padding: 12px 0;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}

.holdings-table-header .col-index {
  text-align: center;
}

.holdings-table-header .col-name {
  padding-left: 4px;
}

.holdings-table-header .col-ratio,
.holdings-table-header .col-change {
  text-align: left;
  padding-left: 4px;
}

.holdings-row {
  display: grid;
  grid-template-columns: 24px 3fr 1fr 1fr 1fr;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-color);
  align-items: center;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.2s;
}

.holdings-row:last-child {
  border-bottom: none;
}

.holdings-row:active {
  background: var(--bg-hover);
}

.holdings-row .col-index {
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
}

.stock-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  overflow: hidden;
}

.stock-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stock-code {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.ratio-cell {
  font-size: 14px;
  font-weight: 500;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  text-align: left;
  padding-left: 4px;
}

.change-cell {
  font-size: 13px;
  font-weight: 500;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
  text-align: left;
  padding-left: 4px;
}

.change-cell.up {
  color: var(--color-up);
}

.change-cell.down {
  color: var(--color-down);
}

.change-cell.new {
  color: #ff976a;
}

.change-from-last-cell {
  font-size: 13px;
  font-weight: 500;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
  text-align: left;
  padding-left: 4px;
}

.change-from-last-cell.new-added {
  color: #ff976a;
}

.change-from-last-cell.up {
  color: var(--color-up);
}

.change-from-last-cell.down {
  color: var(--color-down);
}

.change-from-last-cell.unchanged {
  color: var(--text-secondary);
}

.empty-holdings {
  padding: 48px 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 14px;
}

/* 阶段涨幅 */
.period-section {
  background: var(--bg-secondary);
  margin-bottom: 12px;
}

.period-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 12px 16px;
  gap: 12px;
}

.period-item {
  text-align: center;
  padding: 12px 8px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.period-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.period-return {
  font-size: 16px;
  font-weight: 600;
  font-family: -apple-system, 'SF Mono', monospace;
  font-variant-numeric: tabular-nums;
  margin-bottom: 4px;
}

.period-return.up { color: var(--color-up); }
.period-return.down { color: var(--color-down); }

.period-rank {
  font-size: 11px;
  color: var(--text-secondary);
}

.period-rank .rank-num {
  color: var(--color-primary);
  font-weight: 500;
}

/* 同类对比 */
.similar-section {
  background: var(--bg-secondary);
  margin-bottom: 12px;
}

.similar-list {
  padding: 8px 16px;
}

.similar-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 8px;
  margin: 0 -8px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.2s;
}

.similar-item:active {
  background: var(--bg-card-hover);
}

.similar-item:last-child {
  border-bottom: none;
}

.similar-info {
  flex: 1;
  overflow: hidden;
  margin-right: 12px;
}

.similar-name {
  font-size: 14px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.similar-code {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.similar-return {
  font-size: 14px;
  font-weight: 600;
  font-family: -apple-system, 'SF Mono', monospace;
  font-variant-numeric: tabular-nums;
}

.similar-return.up { color: var(--color-up); }
.similar-return.down { color: var(--color-down); }

.similar-arrow {
  color: var(--text-muted);
  margin-left: 8px;
  font-size: 14px;
}

/* 基金信息 */
.info-grid {
  padding: 16px;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.info-label {
  font-size: 13px;
  color: var(--text-secondary);
}

.info-value {
  font-size: 14px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 基金代码链接 - 跳转京东金融 */
.fund-code-link {
  color: var(--color-primary) !important;
  text-decoration: none;
  cursor: pointer;
}

.fund-code-link:active {
  opacity: 0.7;
}

/* 基金经理入口 */
.manager-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-top: 1px solid var(--border-color);
  cursor: pointer;
  transition: background-color 0.2s;
}

.manager-entry:active {
  background: var(--bg-tertiary);
}

.entry-left {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-primary);
  font-size: 15px;
}

/* ========== 响应式适配 ========== */
@media screen and (max-width: 375px) {
  /* 小屏手机 */
  .price-value {
    font-size: 26px;
  }
  
  .stats-bar {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .holdings-table-header,
  .holdings-row {
    grid-template-columns: 20px 1fr 50px 44px 50px;
  }
  
  .change-cell,
  .ratio-cell,
  .change-from-last-cell {
    font-size: 12px;
  }
}

/* [WHY] 底部安全区域（iPhone底部横条） */
@supports (padding-bottom: env(safe-area-inset-bottom)) {
  .info-section:last-child {
    margin-bottom: calc(12px + env(safe-area-inset-bottom));
  }
}

/* Reference-style detail hierarchy. The existing data and chart components
   remain intact; this layer only controls the page composition. */
.fund-detail-page {
  min-height: 100vh;
  background: var(--bg-primary);
  color: var(--text-primary);
  padding-bottom: max(20px, env(safe-area-inset-bottom));
}

.fund-detail-header {
  position: sticky;
  top: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: 44px 1fr auto;
  align-items: center;
  min-height: 64px;
  padding: max(10px, env(safe-area-inset-top)) 16px 10px;
  background: color-mix(in srgb, var(--bg-primary) 94%, transparent);
  border-bottom: 1px solid var(--border-color);
  backdrop-filter: blur(12px);
}

.fund-detail-header h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  text-align: center;
}

.detail-header-actions {
  display: flex;
  gap: 4px;
}

.detail-icon-button {
  display: inline-grid;
  width: 36px;
  height: 36px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.detail-icon-button:active {
  background: var(--bg-hover);
}

.fund-detail-content {
  width: min(100%, 672px);
  margin: 0 auto;
  padding: 20px 16px 0;
}

.fund-identity {
  margin-bottom: 18px;
}

.identity-main,
.identity-meta {
  display: flex;
  align-items: center;
}

.identity-main {
  gap: 8px;
  min-width: 0;
}

.identity-edit-holding { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 3px; min-height: 24px; padding: 0 6px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--color-primary); background: transparent; font-size: 11px; cursor: pointer; }
.identity-edit-holding:active { background: var(--bg-hover); }

.fund-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-status {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 5px;
  font-size: 11px;
  line-height: 1;
}

.identity-meta {
  gap: 6px;
  margin-top: 7px;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.identity-dot { opacity: .5; }

.detail-stat-grid,
.detail-period-grid {
  display: grid;
  gap: 12px;
}

.detail-stat-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 16px;
}

.detail-stat,
.detail-period {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.detail-stat span,
.detail-period span,
.detail-info-grid span,
.trend-summary span {
  color: var(--text-secondary);
  font-size: 12px;
}

.detail-stat strong,
.detail-period strong,
.trend-summary strong,
.detail-holding-row > span,
.detail-info-grid b,
.detail-info-grid a {
  overflow: hidden;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-stat strong { color: var(--text-primary); }
.detail-stat strong.up,
.detail-period strong.up,
.trend-summary strong.up,
.detail-holding-row > span.up,
.detail-similar-list strong.up { color: var(--color-up); }
.detail-stat strong.down,
.detail-period strong.down,
.trend-summary strong.down,
.detail-holding-row > span.down,
.detail-similar-list strong.down { color: var(--color-down); }

.detail-period-grid {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  padding: 12px 0 18px;
}

.detail-period-section {
  border-top: 1px solid var(--border-color);
}

.period-collapse {
  display: flex;
  min-height: 32px;
  margin: 0 auto;
  align-items: center;
  gap: 5px;
  padding: 0 12px;
  border: 0;
  color: var(--text-secondary);
  background: transparent;
  font-size: 11px;
  cursor: pointer;
}

.period-collapse :deep(.van-icon) {
  font-size: 11px;
}

.detail-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  padding: 3px;
  border-radius: 8px;
  background: var(--bg-tertiary);
}

.detail-tabs button {
  min-height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}

.detail-tabs button.active {
  background: color-mix(in srgb, var(--color-primary) 18%, var(--bg-secondary));
  color: var(--color-primary);
}

.detail-panel {
  margin-top: 18px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.detail-trend-panel { padding: 14px 16px 10px; }

.detail-analysis-panel h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 650;
}

.detail-analysis-panel {
  min-height: 220px;
  padding: 22px 16px;
}

.detail-analysis-panel p {
  margin: 10px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.detail-holding-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 58px 58px 54px;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.detail-holding-row:last-child { border-bottom: 0; }
.detail-holding-heading { color: var(--text-secondary); font-size: 10.2px; }
.detail-holding-heading > span { font-family: inherit; font-size: inherit; }
.detail-holding-row > div { min-width: 0; }
.detail-holding-row > span { font-size: 12.75px; }
.detail-holding-row b,
.detail-holding-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-holding-row b { color: var(--text-primary); font-size: 11.9px; }
.detail-holding-row small { margin-top: 3px; color: var(--text-secondary); font-size: 9.35px; }
.holding-sector { display: inline-block; margin-left: 5px; padding: 1px 4px; border: 1px solid var(--border-color); border-radius: 3px; color: var(--color-primary); font-style: normal; }
.detail-empty { padding: 52px 16px; color: var(--text-secondary); font-size: 11.9px; text-align: center; }

.detail-info-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 14px;
  padding: 18px 16px;
}

.detail-info-grid > div { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
.detail-info-grid b,
.detail-info-grid a { color: var(--text-primary); font-size: 14px; font-weight: 500; }
.detail-manager-link,
.detail-similar-list button {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  border: 0;
  border-top: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
}
.detail-manager-link { padding: 15px 16px; font-size: 14px; }
.detail-similar-list button { gap: 12px; padding: 13px 16px; font-size: 13px; text-align: left; }
.detail-similar-list button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.detail-loading { display: grid; min-height: calc(100vh - 64px); place-items: center; }

.detail-holding-editor { display: flex; min-height: 360px; max-height: 76dvh; flex-direction: column; background: var(--bg-secondary); }
.detail-holding-editor header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid var(--border-color); color: var(--text-primary); }
.detail-holding-editor header strong { font-size: 16px; }
.detail-holding-editor header button { display: grid; width: 32px; height: 32px; place-items: center; padding: 0; border: 0; border-radius: 6px; color: var(--text-secondary); background: transparent; }
.detail-holding-editor header button:active { background: var(--bg-hover); }
.detail-holding-editor-body { flex: 1; overflow-y: auto; }
.detail-holding-editor footer { padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); border-top: 1px solid var(--border-color); }

@media (min-width: 641px) {
  .fund-detail-page {
    width: min(100% - 40px, 704px);
    min-height: auto;
    margin: 24px auto;
    border: 1px solid var(--border-color);
    border-radius: 14px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, .22);
    overflow: hidden;
  }

  .fund-detail-header { border-bottom-color: var(--border-color); }
  .fund-detail-content { padding: 24px 24px 0; }
  .detail-panel { margin-bottom: 24px; }
}

@media (max-width: 430px) {
  .fund-detail-content { padding: 16px 12px 0; }
  .detail-stat-grid { gap: 8px; }
  .detail-stat strong, .detail-period strong { font-size: 13px; }
  .detail-period-grid { gap: 6px; }
  .detail-period span { font-size: 11px; }
}

@media (max-width: 340px) {
  .detail-stat-grid { gap: 5px; }
  .detail-stat strong { font-size: 11px; }
  .detail-period strong { font-size: 11px; }
  .detail-period-grid { gap: 3px; }
  .detail-period span { font-size: 10px; }
}
</style>
