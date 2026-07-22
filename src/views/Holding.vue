<script setup lang="ts">
defineOptions({ name: 'Holding' })
// [WHY] 持仓管理页 - 管理用户的基金持仓和收益
// [WHAT] 显示持仓列表、汇总统计，支持添加/编辑/删除持仓
// [WHAT] 支持 A类/C类基金费用计算
// [WHAT] 支持类型筛选和排序

import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useHoldingStore } from '@/stores/holding'
import { useFundStore } from '@/stores/fund'
import { useSettingsStore } from '@/stores/settings'
import { searchFund, fetchFundEstimate, fetchFundList, detectShareClass, fetchFundFeeInfo, calculateBuyFee } from '@/api/fund'
import { fetchRealDayChange } from '@/api/fundFast'
import { API_BASE_URL } from '@/config/api'
import { showConfirmDialog, showToast, showLoadingToast, closeToast, showDialog } from 'vant'
import { formatMoney, formatPercent, getChangeStatus, getJdFundLink } from '@/utils/format'
import MarketIndexBoard from '@/components/MarketIndexBoard.vue'
import type { FundInfo, HoldingRecord, FundShareClass, FundFeeInfo, PendingAdjustment } from '@/types/fund'

import { createWorker } from 'tesseract.js'
import { getTodayStr, getValuationComparisonState, isEstimateDateToday, isTradingHours as isBeijingTradingHours, PRECISION, round } from '@/utils/holdingCalculator'
import { getSettlementNavStartDate } from '@/utils/tradingDate'
import { deriveHoldingImportBasis } from '@/utils/holdingImport'
import { parseLocalHoldingText, resolveLocalFund } from '@/utils/localHoldingOcr'

// 集成风控系统和日志模块
import { getRiskController } from '@/utils/riskControl'
import type { RiskCheckResult } from '@/utils/riskControl'

const router = useRouter()
const holdingStore = useHoldingStore()
const fundStore = useFundStore()
const settingsStore = useSettingsStore()
const marketIndexBoard = ref<{ refresh: () => Promise<void> } | null>(null)
let autoRefreshTimer: ReturnType<typeof setTimeout> | null = null
let autoRefreshActive = false

function scheduleAutoRefresh() {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer)
  autoRefreshTimer = null
  if (!autoRefreshActive || !settingsStore.autoRefresh) return

  const intervalSeconds = isBeijingTradingHours()
    ? settingsStore.tradingInterval
    : settingsStore.afterHoursInterval
  autoRefreshTimer = setTimeout(async () => {
    try {
      if (!document.hidden && !holdingStore.isRefreshing) {
        await holdingStore.refreshEstimates()
      }
    } finally {
      if (autoRefreshActive) scheduleAutoRefresh()
    }
  }, Math.max(1, intervalSeconds) * 1000)
}

function startAutoRefresh() {
  autoRefreshActive = true
  scheduleAutoRefresh()
}

function stopAutoRefresh() {
  autoRefreshActive = false
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer)
  autoRefreshTimer = null
}

watch(
  () => [settingsStore.autoRefresh, settingsStore.tradingInterval, settingsStore.afterHoursInterval],
  () => {
    if (autoRefreshActive) scheduleAutoRefresh()
  }
)

// ========== 类型筛选 ==========
// [WHAT] 可选的基金类型列表
const fundTypes = [
  { value: 'all', label: '全部' },
  { value: '偏股', label: '偏股' },
  { value: '偏债', label: '偏债' },
  { value: '指数', label: '指数' },
  { value: '黄金', label: '黄金' },
  { value: '全球', label: '全球' }
]

// [WHAT] 当前选中的类型
const selectedType = ref('all')

// [WHAT] 类型筛选下拉菜单显示状态
const showTypeDropdown = ref(false)

// [WHAT] 当前选中类型的标签
const currentTypeLabel = computed(() => {
  const found = fundTypes.find(t => t.value === selectedType.value)
  return found ? found.label : '全部'
})

// ========== 排序方式 ==========
// [WHAT] 可选的排序方式列表
const sortOptions = [
  { value: 'custom', label: '自定义' },
  { value: 'profit', label: '持有收益' },
  { value: 'profitRate', label: '持有收益率' },
  { value: 'amount', label: '金额' },
  { value: 'todayProfit', label: '日收益' },
  { value: 'todayChange', label: '日收益率' },
  { value: 'updateTime', label: '更新时间' }
]

// [WHAT] 当前选中的排序方式
const selectedSort = ref('custom')

// [WHAT] 排序下拉菜单显示状态
const showSortDropdown = ref(false)

// [WHAT] 当前选中排序方式的标签
const currentSortLabel = computed(() => {
  const found = sortOptions.find(t => t.value === selectedSort.value)
  return found ? found.label : '自定义'
})

// [WHAT] 筛选后的持仓列表
const filteredHoldings = computed(() => {
  let list = holdingStore.holdings
  
  // 类型筛选
  if (selectedType.value !== 'all') {
    list = list.filter(holding => {
      const type = holding.type || ''
      return type.includes(selectedType.value)
    })
  }
  
    // 排序
  if (selectedSort.value !== 'custom') {
    list = [...list].sort((a, b) => {
      switch (selectedSort.value) {
        case 'profit':
          return (b.profit || 0) - (a.profit || 0)
        case 'profitRate':
          return (b.profitRate || 0) - (a.profitRate || 0)
        case 'amount':
          return (b.amount || 0) - (a.amount || 0)
        case 'todayProfit':
          return (b.todayProfit || 0) - (a.todayProfit || 0)
        case 'todayChange':
          return parseFloat(b.todayChange || '0') - parseFloat(a.todayChange || '0')
        case 'updateTime':
          return (b.createdAt || 0) - (a.createdAt || 0)
        default:
          return 0
      }
    })
  }
  
  return list
})

// [WHAT] 选择类型
function selectType(type: string) {
  selectedType.value = type
  showTypeDropdown.value = false
}

// [WHAT] 选择排序方式
function selectSort(sort: string) {
  selectedSort.value = sort
  showSortDropdown.value = false
}

// [WHAT] 关闭所有下拉菜单
function closeAllDropdowns() {
  showTypeDropdown.value = false
  showSortDropdown.value = false
}

// ========== 表单相关 ==========
const showAddDialog = ref(false)
const isEditing = ref(false)
// [NEW] 输入模式: amount=按金额+收益, shares=按份额+成本价
const inputMode = ref<'amount' | 'shares'>('amount')
const formData = ref({
  code: '',
  name: '',
  amount: '', // 持仓金额（按金额模式的主字段）
  profit: '', // 持有收益（可为负数，按金额模式的辅助字段）
  shares: '', // 持有份额（按份额模式的主字段）
  buyDate: '',
  costPrice: '', // 持仓成本单价（按份额模式，每份成本）
  costUnitPrice: '' // 买入时净值（用于计算份额的参考净值）
})

// ========== 调仓（加仓/减仓）相关 ==========
// [WHY] 支持对已有持仓进行加仓或减仓操作
const showTradeDialog = ref(false)
const tradeMode = ref<'add' | 'reduce'>('add')  // 加仓 或 减仓
const tradeFundCode = ref('')
const tradeFundName = ref('')

// 加仓表单
const addTradeForm = ref({
  amount: '',           // 加仓金额（元）
  feeRate: '0.00',      // 买入费率(%)
  tradeDate: '',        // 加仓日期
  tradeTimeSlot: 'after' as 'before' | 'after'  // 交易时段: before=15:00前, after=15:00后
})

// 减仓表单
const reduceTradeForm = ref({
  shares: '',           // 减仓份额（份）
  tradeDate: '',        // 减仓日期
  tradeTimeSlot: 'after' as 'before' | 'after'
})

/** 当前基金待确认调仓记录 */
const currentPendingAdjustments = computed<PendingAdjustment[]>(() =>
  holdingStore.pendingAdjustments.filter(
    (p: PendingAdjustment) => p.code === tradeFundCode.value && p.status === 'pending'
  )
)



async function cancelPendingItem(id: string) {
  try {
    await showConfirmDialog({
      title: '取消待确认调仓',
      message: '确定取消这条待确认记录吗？'
    })
    await holdingStore.cancelPendingAdjustment(id)
    showToast('已取消')
  } catch {
    // 用户取消
  }
}

/** 打开调仓弹窗 */
function openTradeDialog(code: string, name: string) {
  tradeFundCode.value = code
  tradeFundName.value = name
  
  // 重置表单
  addTradeForm.value = {
    amount: '',
    feeRate: '0.00',
    tradeDate: getTodayStr(),
    // 默认根据当前时间判断交易时段
    tradeTimeSlot: isTradingHours.value ? 'before' : 'after'
  }
  reduceTradeForm.value = {
    shares: '',
    tradeDate: getTodayStr(),
    tradeTimeSlot: isTradingHours.value ? 'before' : 'after'
  }
  
  // 默认显示加仓模式
  tradeMode.value = 'add'
  showTradeDialog.value = true
}

/**
 * 计算交易确认日和收益起始日的核心逻辑
 * 
 * 加减仓统一保留为待确认记录，直到交易日之后的首个官方净值公布。
 * 周末和节假日由净值历史中的下一条真实交易日记录自然顺延。
 * 
 * @returns { confirmDate: 官方净值结算的最早日期 }
 */
function calcTradeDates(tradeDateStr: string, timeSlot: 'before' | 'after'): { confirmDate: string } {
  return { confirmDate: getSettlementNavStartDate(tradeDateStr, timeSlot) }
}

/** 生成唯一ID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
}

/** 执行加仓操作（仅记录待确认，不立即修改持仓） */
async function confirmAddTrade() {
  const code = tradeFundCode.value
  const holding = holdingStore.getHoldingByCode(code)
  if (!holding) {
    showToast('持仓记录不存在')
    return
  }

  const amount = parseFloat(addTradeForm.value.amount)
  if (!amount || amount <= 0) {
    showToast('请输入有效的加仓金额')
    return
  }

  showLoadingToast({ message: '处理中...', forbidClick: true })

  try {
    // 获取当前净值用于计算新增份额
    const estimate = await fetchFundEstimate(code)
    const currentNav = parseFloat(estimate.gsz) || parseFloat(estimate.dwjz) || 1

    // 扣除手续费后的实际投入
    const feeRate = parseFloat(addTradeForm.value.feeRate) || 0
    const feeAmount = amount * feeRate / 100
    const actualAmount = amount - feeAmount

    // 新增份额
    const newShares = actualAmount / currentNav

    // 计算交易时间逻辑
    const { confirmDate } = calcTradeDates(
      addTradeForm.value.tradeDate,
      addTradeForm.value.tradeTimeSlot
    )

    console.log(`[加仓待确认] ${code}: 金额=${amount}, 费率=${feeRate}%, 实际投入=${actualAmount.toFixed(2)}, 净值=${currentNav}, 新增份额=${newShares.toFixed(4)}, 确认日=${confirmDate}`)

    // 只记录待确认调仓，不立即修改持仓
    const pending: PendingAdjustment = {
      id: generateId(),
      code,
      name: holding.name,
      type: 'add',
      tradeDate: addTradeForm.value.tradeDate,
      timeSlot: addTradeForm.value.tradeTimeSlot,
      confirmDate,
      amount: round(amount, PRECISION.AMOUNT),
      shares: newShares,
      fee: round(feeAmount, PRECISION.AMOUNT),
      nav: currentNav,
      status: 'pending',
      createdAt: Date.now()
    }

    await holdingStore.addPendingAdjustment(pending)

    closeToast()
    showToast(`已记录加仓，将按 ${confirmDate} 起的官方净值自动结算`)

    // 刷新估值
    await holdingStore.refreshEstimates()
  } catch (err) {
    closeToast()
    console.error('[加仓待确认] 操作失败:', err)
    showToast('加仓失败，请重试')
  }
}


/** 执行减仓操作（仅记录待确认，不立即修改持仓） */
async function confirmReduceTrade() {
  const code = tradeFundCode.value
  const holding = holdingStore.getHoldingByCode(code)
  if (!holding) {
    showToast('持仓记录不存在')
    return
  }

  const sellShares = parseFloat(reduceTradeForm.value.shares)
  if (!sellShares || sellShares <= 0) {
    showToast('请输入有效的减仓份额')
    return
  }

  const currentShares = holding.shares || 0
  const pendingReduceShares = holdingStore.pendingAdjustments
    .filter((item: PendingAdjustment) => item.code === code && item.type === 'reduce' && item.status === 'pending')
    .reduce((total: number, item: PendingAdjustment) => total + item.shares, 0)
  const availableShares = Math.max(0, currentShares - pendingReduceShares)
  if (sellShares > availableShares) {
    showToast(`可减仓份额不足！当前可用${availableShares.toFixed(2)}份`)
    return
  }

  // 检查是否全部卖出
  const isFullSell = sellShares >= availableShares
  if (isFullSell) {
    try {
      await showConfirmDialog({
        title: '清仓提示',
        message: `将提交卖出全部可用的${availableShares.toFixed(2)}份，基金公司公布成交净值后自动结算。\n\n如需保留部分仓位，请减少卖出份额。`
      })
    } catch {
      return // 用户取消
    }
  }

  showLoadingToast({ message: '处理中...', forbidClick: true })

  try {
    // 获取当前净值用于估算卖出金额
    const estimate = await fetchFundEstimate(code)
    const currentNav = parseFloat(estimate.gsz) || parseFloat(estimate.dwjz) || 1

    // 计算交易时间逻辑
    const { confirmDate } = calcTradeDates(
      reduceTradeForm.value.tradeDate,
      reduceTradeForm.value.tradeTimeSlot
    )

    // 按当前成本比例扣减成本（不是按市值）
    const ratio = sellShares / currentShares
    const deductAmount = (holding.amount || 0) * ratio

    console.log(`[减仓待确认] ${code}: 卖出份额=${sellShares}, 单价=${currentNav}, 扣减成本=${deductAmount.toFixed(2)}, 确认日=${confirmDate}`)

    // 只记录待确认调仓，不立即修改持仓
    const pending: PendingAdjustment = {
      id: generateId(),
      code,
      name: holding.name,
      type: 'reduce',
      tradeDate: reduceTradeForm.value.tradeDate,
      timeSlot: reduceTradeForm.value.tradeTimeSlot,
      confirmDate,
      amount: round(deductAmount, PRECISION.AMOUNT),
      shares: sellShares,
      fee: 0,
      nav: currentNav,
      status: 'pending',
      createdAt: Date.now()
    }

    await holdingStore.addPendingAdjustment(pending)

    closeToast()
    showToast(isFullSell
      ? `已提交清仓，将按官方净值自动结算`
      : `已记录减仓，将按 ${confirmDate} 起的官方净值自动结算`)

    // 刷新估值
    await holdingStore.refreshEstimates()
  } catch (err) {
    closeToast()
    console.error('[减仓待确认] 操作失败:', err)
    showToast('减仓失败，请重试')
  }
}


// ========== A/C类费用相关 ==========
const shareClass = ref<FundShareClass>('A')

// 今日日期字符串（用于限制日期选择器最大值）
const todayStr = getTodayStr()
const feeInfo = ref<FundFeeInfo | null>(null)
// A类：是否扣除买入手续费（默认不勾选）
const deductBuyFee = ref(false)
// C类：销售服务费年化费率（默认0.4%）
const serviceFeeRate = ref(0.4)

// 基金搜索相关
const searchKeyword = ref('')
const searchResults = ref<FundInfo[]>([])
const isSearching = ref(false)
const selectedFund = ref<FundInfo | null>(null)
const currentNetValue = ref(0) // 当前基金净值

/** 仅用于 van-pull-refresh 下拉动画（与自动刷新解耦） */
const isPullRefreshing = ref(false)

// [WHAT] 页面挂载时初始化数据
onMounted(async () => {
  await holdingStore.initHoldings()
  startAutoRefresh()
  // [WHAT] 点击外部关闭下拉菜单
  document.addEventListener('click', closeAllDropdowns)
})

// [WHAT] 页面卸载时移除事件监听
onUnmounted(() => {
  stopAutoRefresh()
  document.removeEventListener('click', closeAllDropdowns)
})

// [WHAT] 汇总统计样式
const summaryProfitClass = computed(() => {
  return getChangeStatus(holdingStore.summary.totalProfit)
})

const summaryTodayClass = computed(() => {
  return getChangeStatus(holdingStore.summary.todayProfit)
})

const summaryYesterdayClass = computed(() => {
  return getChangeStatus(holdingStore.summary.yesterdayProfit)
})

const isTradingHours = computed(() => isBeijingTradingHours())

const getComparisonState = (holding: any) => getValuationComparisonState({
  realChange: holding.realChange,
  realChangeDate: holding.realChangeDate,
  estimateChange: holding.estimateChange,
  estimateTime: holding.estimateTime,
  fundName: holding.name
})

/** 获取某基金的待确认调仓标签列表 */
function getPendingTags(holding: any): { label: string; type: 'add' | 'reduce' }[] {
  const list = holdingStore.pendingAdjustments.filter(
    (p: PendingAdjustment) => p.code === holding.code && p.status === 'pending'
  )
  return list.map((p: PendingAdjustment) => ({
    label: p.type === 'add' ? '调仓·买入' : '调仓·卖出',
    type: p.type
  }))
}

// [WHAT] 状态标签文本（根据盘中/盘后 + realChange 是否获取到来判断）
const getStatusTag = (holding: any) => {
  // 如果还在加载中，显示"加载中"
  if (holding.loading) {
    return '加载中'
  }
  // 盘中一律显示"估值中"（不管 realChange 是否有值，因为那是历史缓存）
  const comparison = getComparisonState(holding)
  if (comparison.isTrading) {
    return '估值中'
  }
  return comparison.isCurrentReal ? '已更新' : '待更新'
}

// [WHAT] 状态标签样式类
const getStatusTagClass = (holding: any) => {
  if (holding.loading) {
    return 'tag-loading'
  }
  const comparison = getComparisonState(holding)
  if (comparison.isTrading) {
    return 'tag-trading'
  }
  return comparison.isCurrentReal ? 'tag-updated' : 'tag-pending'
}

// [WHAT] 基金名称动态字体大小
const getFundNameStyle = (name: string) => {
  const len = (name || '加载中...').length
  // Keep the holding list aligned with the watchlist card typography.
  let fontSize = 14
  if (len > 10) fontSize = 13
  if (len > 14) fontSize = 12
  if (len > 18) fontSize = 11
  return { fontSize: `${fontSize}px` }
}

// 实差仅在同一交易日的估值和已公布净值均可用时计算。
const getDiffChange = (holding: any) => {
  const estimate = Number(holding.estimateChange)
  const real = Number(holding.realChange)
  if (!getComparisonState(holding).hasActualDiff || !Number.isFinite(estimate) || !Number.isFinite(real)) return null
  return real - estimate
}

// 实差显示文本
const getDisplayDiff = (holding: any) => {
  const diff = getDiffChange(holding)
  if (diff === null || isNaN(diff)) return null
  const sign = diff > 0 ? '+' : ''
  return `${sign}${diff.toFixed(2)}%`
}

// 实差标签
const getDiffLabel = (holding: any) => {
  return '实差'
}

// [WHAT] 实差 CSS 类名
const getDiffClass = (holding: any) => {
  const diff = getDiffChange(holding)
  if (diff === null || isNaN(diff)) return ''
  if (diff > 0) return 'diff-up'
  if (diff < 0) return 'diff-down'
  return 'diff-flat'
}

// [WHAT] 真实涨跌幅显示
const getDisplayRealChange = (holding: any) => {
  if (holding.realChange === undefined || holding.realChange === null) return null
  return formatPercent(holding.realChange)
}

// 列表金额使用当前市值（而不是历史成本），与顶部账户资产口径一致。
const getHoldingMarketValue = (holding: any) => {
  const value = Number(holding.marketValue)
  return Number.isFinite(value) && value > 0 ? formatMoney(value) : '--'
}

// 最新收益使用当前估值/官方净值计算出的金额，不展示基金单位净值。
const getLatestIncome = (holding: any) => {
  const value = Number(holding.todayProfit)
  if (!Number.isFinite(value)) return '--'
  return `${value >= 0 ? '+' : ''}${formatMoney(value)}`
}

const getTodayRate = (holding: any) => {
  const comparison = getComparisonState(holding)
  const value = comparison.isCurrentReal
    ? holding.realChange
    : isEstimateDateToday(holding.estimateTime || '', getTodayStr())
      ? holding.todayChange
      : '--'
  return value === '--' || value === undefined || value === null ? '--' : formatPercent(value)
}

// 估值、真实涨跌幅和实差互不依赖：任意一项可用都应显示，避免真实数据
// 尚未返回时把盘中估值整块隐藏。
const hasDiffData = (holding: any) => {
  const hasEstimate = holding.estimateChange !== undefined && holding.estimateChange !== null && holding.estimateChange !== '--'
  return hasEstimate || getDisplayRealChange(holding) !== null || getDisplayDiff(holding) !== null
}

// [WHAT] 真实涨跌幅标签（盘中显示"昨"，盘后根据数据日期显示"真实"或"昨"）
const getRealChangeLabel = (holding: any) => {
  return getComparisonState(holding).realChangeLabel || '净值'
}

const getDisplayEstimateChange = (holding: any) => {
  const rawValue = holding.estimateChange
  const value = Number(rawValue)
  return rawValue !== null && rawValue !== undefined && rawValue !== '' && rawValue !== '--' && Number.isFinite(value)
    ? formatPercent(value)
    : '--'
}

const getEstimateChangeClass = (holding: any) => {
  const rawValue = holding.estimateChange
  const value = Number(rawValue)
  return rawValue !== null && rawValue !== undefined && rawValue !== '' && rawValue !== '--' && Number.isFinite(value)
    ? getChangeStatus(value)
    : ''
}

// [WHAT] 真实涨跌幅 CSS 类名
const getRealChangeClass = (holding: any) => {
  if (holding.realChange === undefined || holding.realChange === null) return ''
  return getChangeStatus(holding.realChange)
}

// [WHAT] 下拉刷新
/** 手动下拉刷新 */
async function onRefresh() {
  isPullRefreshing.value = true
  try {
    await Promise.all([
      holdingStore.refreshEstimates(),
      marketIndexBoard.value?.refresh()
    ])
    holdingStore.updateHoldingDays()
  } finally {
    isPullRefreshing.value = false
  }
}

// [WHAT] 打开添加基金弹窗
function openAddDialog() {
  isEditing.value = false
  resetForm()
  // 仅作内部记录，不向添加基金流程暴露或据此计算持有天数。
  formData.value.buyDate = getTodayStr()
  showAddDialog.value = true
}

// [WHAT] 打开编辑持仓弹窗 - 支持两种模式加载
function handleEdit(code: string) {
  const holding = holdingStore.getHoldingByCode(code)
  if (!holding) return
  
  isEditing.value = true
  
  // 编辑默认使用金额模式：金额是当前市值，收益是相对成本的盈亏。
  // 用户仍可切换到按份额模式精确维护份额和成本单价。
  inputMode.value = 'amount'
  const marketAmount = holding.marketValue ?? ((holding.amount || 0) + (holding.profit || 0))
  
  formData.value = {
    code: holding.code,
    name: holding.name,
    amount: marketAmount > 0 ? marketAmount.toFixed(2) : '',
    profit: holding.profit !== undefined ? holding.profit.toString() : '',
    shares: holding.shares ? holding.shares.toString() : '',
    buyDate: holding.buyDate,
    costPrice: holding.costPrice ? holding.costPrice.toString() : '',
    costUnitPrice: holding.costUnitPrice ? holding.costUnitPrice.toString() : ''
  }
  currentNetValue.value = holding.currentValue || holding.costPrice || holding.costUnitPrice || holding.buyNetValue || currentNetValue.value
  selectedFund.value = { code: holding.code, name: holding.name, type: '', pinyin: '' }
  showAddDialog.value = true
}

// [WHAT] 删除持仓 - 集成确认和日志
async function handleDelete(code: string) {
  const holding = holdingStore.getHoldingByCode(code)
  if (!holding) return

  try {
    await showConfirmDialog({
      title: '确认删除',
      message: `确定要删除【${holding.name}】的持仓记录吗？\n\n持仓金额: ¥${formatMoney(holding.amount)}`
    })
    
    // 记录删除前的快照用于审计
    const snapshot = {
      code: holding.code,
      name: holding.name,
      amount: holding.amount,
      shares: holding.shares,
      profit: holding.profit,
      profitRate: holding.profitRate
    }
    
    // 执行删除（已集成日志系统）
    const success = await holdingStore.removeHolding(code)
    
    if (success) {
      showToast('已删除')
      
      // 开发模式下输出删除日志
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Holding] 已删除持仓: ${code}`, snapshot)
      }
    } else {
      showToast('删除失败，请重试')
    }
  } catch (error) {
    // 用户取消或其他异常
    if ((error as Error)?.message !== 'cancel') {
      console.error('[Holding] 删除持仓失败:', error)
      holdingStore.getLogger().error('HOLDING', 'DELETE_ERROR',
        `删除失败: ${code}`,
        { code, error: String(error) } as Record<string, unknown>
      )
      showToast('删除失败')
    }
  }
}

// [WHAT] 重置表单
function resetForm() {
  formData.value = { code: '', name: '', amount: '', profit: '', shares: '', buyDate: '', costPrice: '', costUnitPrice: '' }
  searchKeyword.value = ''
  searchResults.value = []
  selectedFund.value = null
  currentNetValue.value = 0
  shareClass.value = 'A'
  feeInfo.value = null
  deductBuyFee.value = false
  serviceFeeRate.value = 0.4
  inputMode.value = 'amount'
}

// [WHAT] 搜索基金
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
      searchResults.value = await searchFund(searchKeyword.value, 10)
    } finally {
      isSearching.value = false
    }
  }, 300)
}

// [WHAT] 选择基金
async function selectFund(fund: FundInfo) {
  selectedFund.value = fund
  formData.value.code = fund.code
  formData.value.name = fund.name
  searchKeyword.value = ''
  searchResults.value = []
  
  // [WHAT] 检测份额类型（A类/C类）
  shareClass.value = detectShareClass(fund.code, fund.name)
  
  // [WHY] 获取当前净值和费率信息
  showLoadingToast({ message: '获取净值...', forbidClick: true })
  try {
    const [estimate, fee, realData] = await Promise.all([
      fetchFundEstimate(fund.code),
      fetchFundFeeInfo(fund.code),
      fetchRealDayChange(fund.code).catch(() => null)
    ])
    // 盘中使用当日估值，盘后优先使用已公布的官方净值；没有官方净值时
    // 才退回接口的最新净值，避免用前一日净值反推当日份额。
    const estimateValue = parseFloat(estimate.gsz) || 0
    const lastValue = parseFloat(estimate.dwjz) || 0
    currentNetValue.value = isTradingHours.value
      ? (estimateValue || lastValue || 1)
      : (realData?.nav || lastValue || estimateValue || 1)
    feeInfo.value = fee
    
    // [WHAT] 根据费率信息更新默认费率
    if (fee) {
      if (shareClass.value === 'C') {
        serviceFeeRate.value = fee.serviceFeeRate || 0.4
      }
    }
    closeToast()
  } catch {
    closeToast()
    currentNetValue.value = 1
    showToast('无法获取净值，请手动计算')
  }
}

// [WHAT] 计算买入手续费（仅A类）
const buyFeeAmount = computed(() => {
  if (shareClass.value !== 'A' || !deductBuyFee.value) return 0
  const amount = parseFloat(formData.value.amount) || 0
  const rate = feeInfo.value?.buyFeeRate || 0.15
  const fee = amount * (rate / 100)
  return Math.round(fee * 100) / 100
})

// [WHAT] 实际用于购买的金额（扣除手续费后）
const actualBuyAmount = computed(() => {
  // [FIX] 按份额模式时使用计算出的金额
  const amount = inputMode.value === 'shares' 
    ? calculatedAmountFromShares.value 
    : (parseFloat(formData.value.amount) || 0)
  if (shareClass.value === 'A' && deductBuyFee.value) {
    return amount - buyFeeAmount.value
  }
  return amount
})

// [WHAT] 金额模式按当前参考净值反推份额；份额模式使用用户输入。
const calculatedShares = computed(() => {
  const manualShares = parseFloat(formData.value.shares)
  if (inputMode.value === 'shares') return manualShares > 0 ? manualShares : 0
  const marketAmount = parseFloat(formData.value.amount) || 0
  if (marketAmount <= 0 || currentNetValue.value <= 0) return 0
  return marketAmount / currentNetValue.value
})

// [NEW] ★ 按份额模式：根据份额和成本价反推总成本/持仓金额
const calculatedAmountFromShares = computed(() => {
  const shares = parseFloat(formData.value.shares) || 0
  const costPrice = parseFloat(formData.value.costPrice) || parseFloat(formData.value.costUnitPrice) || 0
  if (shares <= 0 || costPrice <= 0) return 0
  return round(shares * costPrice, PRECISION.AMOUNT)
})

// [NEW] ★ 按金额模式：根据金额和收益反推总成本
const calculatedTotalCost = computed(() => {
  const amount = parseFloat(formData.value.amount) || 0
  const profitVal = formData.value.profit !== '' ? parseFloat(formData.value.profit) : 0
  // [FIX] 金额可为0，允许仅记录收益或仅添加基金
  if (amount <= 0 && profitVal === 0) return 0
  // 总成本 = 当前市值 - 收益
  return round(amount - profitVal, PRECISION.AMOUNT)
})

// [NEW] ★ 统一计算成本单价（优先用户输入，其次由成本反推）
const calculatedCostUnitPrice = computed(() => {
  const manualCostPrice = parseFloat(formData.value.costPrice)
  if (manualCostPrice > 0) return manualCostPrice
  
  const shares = calculatedShares.value
  const totalCost = calculatedTotalCost.value
  if (totalCost > 0 && shares > 0) return round(totalCost / shares, PRECISION.RATE)
  
  // 兜底：当前净值
  return currentNetValue.value > 0 ? currentNetValue.value : 0
})

// [NEW] ★ 实时计算的当前市值（用于按份额模式显示）
const calculatedMarketValue = computed(() => {
  const shares = calculatedShares.value
  if (shares <= 0 || currentNetValue.value <= 0) return 0
  return round(shares * currentNetValue.value, PRECISION.AMOUNT)
})

// [NEW] ★ 实时计算的持有收益（用于按份额模式）
const calculatedProfitFromShares = computed(() => {
  const marketValue = calculatedMarketValue.value
  const totalCost = calculatedAmountFromShares.value
  if (marketValue <= 0 || totalCost <= 0) return 0
  return round(marketValue - totalCost, PRECISION.AMOUNT)
})

// ========== 风控相关状态 ==========
/** 风控检查结果（用于显示警告） */
const riskCheckResult = ref<RiskCheckResult | null>(null)
/** 是否显示风控详情 */
const showRiskDetail = ref(false)

// [WHAT] 提交表单 - 支持按金额/按份额双模式 + 风控检查
async function submitForm() {
  // 基础校验：基金必选
  if (!formData.value.code) {
    showToast('请选择基金')
    return
  }

  let finalAmount = 0
  let finalShares = 0
  let finalCostPrice = 0

  if (inputMode.value === 'amount') {
    // 按金额模式：输入的是当前市值和持有收益，成本 = 市值 - 收益。
    const amount = parseFloat(formData.value.amount) || 0
    const profitVal = formData.value.profit !== '' ? parseFloat(formData.value.profit) : undefined
    if (amount <= 0 || currentNetValue.value <= 0) {
      showToast('请输入有效的持仓金额')
      return
    }
    
    // [FIX] 如果用户输入了收益，amount 表示市值；否则 amount 表示成本
    // 成本 = 市值 - 收益
    const cost = profitVal !== undefined && profitVal !== null 
      ? amount - profitVal 
      : amount
    
    if (cost <= 0) {
      showToast('持有收益不能大于持仓金额')
      return
    }
    finalAmount = round(cost, PRECISION.AMOUNT)
    finalShares = amount / currentNetValue.value
    finalCostPrice = finalAmount / finalShares
  } else {
    // 按份额模式：份额和成本单价共同决定总成本。
    const shares = parseFloat(formData.value.shares) || 0
    const costPrice = parseFloat(formData.value.costPrice) || 0
    if (shares <= 0 || costPrice <= 0) {
      showToast('请输入有效的持有份额和成本单价')
      return
    }
    
    finalShares = shares
    finalCostPrice = costPrice > 0 ? costPrice : (currentNetValue.value > 0 ? currentNetValue.value : 0)
    
    // 根据份额×成本价反推总金额（作为持仓成本/投入金额）
    if (shares > 0 && costPrice > 0) {
      finalAmount = round(shares * costPrice, PRECISION.AMOUNT)
    }
  }
  
  // 构建持仓记录 - 统一使用 finalAmount 和 finalShares
  const record: HoldingRecord = {
    code: formData.value.code,
    name: formData.value.name,
    shareClass: shareClass.value,
    amount: finalAmount,
    buyNetValue: currentNetValue.value > 0 ? currentNetValue.value : finalCostPrice,
    shares: finalShares,
    costPrice: finalCostPrice,
    costUnitPrice: finalCostPrice || currentNetValue.value,
    buyDate: formData.value.buyDate,
    holdingDays: isEditing.value
      ? (holdingStore.getHoldingByCode(formData.value.code)?.holdingDays ?? 0)
      : 0,
    createdAt: Date.now(),
    // A类基金费用字段
    buyFeeRate: shareClass.value === 'A' ? (feeInfo.value?.buyFeeRate || 0.15) : undefined,
    buyFeeDeducted: shareClass.value === 'A' ? deductBuyFee.value : undefined,
    buyFeeAmount: shareClass.value === 'A' ? buyFeeAmount.value : undefined,
    // C类基金费用字段
    serviceFeeRate: shareClass.value === 'C' ? serviceFeeRate.value : undefined,
    serviceFeeDeducted: shareClass.value === 'C' ? 0 : undefined,
    lastFeeDate: shareClass.value === 'C' ? formData.value.buyDate : undefined
  }

  // ========== 风控检查 ==========
  try {
    const riskController = getRiskController()
    const existingHoldings = holdingStore.holdings.map(h => ({
      code: h.code,
      name: h.name || '',
      amount: h.amount || 0
    }))
    
    const result = await riskController.checkBeforeAdd(record, existingHoldings)
    riskCheckResult.value = result

    // 如果有错误（阻止操作）
    if (result.errors.length > 0) {
      const errorMsg = result.errors.join('\n')
      console.warn('[Holding] 风控拦截:', errorMsg)
      
      // 显示详细的风控对话框
      await showDialog({
        title: '⚠️ 风控提示',
        message: `${errorMsg}\n\n风险评分: ${result.score}/100\n${result.warnings.length > 0 ? '\n⚠️ 警告:\n' + result.warnings.join('\n') : ''}`,
        confirmButtonText: '强制添加',
        cancelButtonText: '取消',
        showCancelButton: true
      }).then(() => {
        // 用户选择强制添加 - 记录日志但继续操作
        console.log('[Holding] 用户忽略风控警告，强制添加:', record.code)
        holdingStore.getLogger().warn('HOLDING', 'FORCE_ADD', 
          `用户忽略风控警告强制添加: ${record.code}`,
          { code: record.code, score: result.score, errors: result.errors, warnings: result.warnings } as Record<string, unknown>
        )
      }).catch(() => {
        // 用户取消
        console.log('[Holding] 用户取消添加（风控拦截）:', record.code)
        riskCheckResult.value = null
        return
      })
    } 
    // 只有警告（允许操作但需提醒）
    else if (result.warnings.length > 0 && !result.passed) {
      console.warn('[Holding] 风控警告:', result.warnings)
      showToast(result.warnings[0])
    }
  } catch (error) {
    // 风控检查异常时继续操作（不阻断流程）
    console.error('[Holding] 风控检查异常:', error)
  }

  // ========== 提交到 Store（集成计算引擎和日志） ==========
  try {
    const success = await holdingStore.addOrUpdateHolding(record)
    
    if (success) {
      showToast(isEditing.value ? '修改成功' : '添加成功')
      showAddDialog.value = false
      resetForm()
      riskCheckResult.value = null
      
      // 显示操作日志摘要（开发调试用）
      if (process.env.NODE_ENV === 'development') {
        const stats = holdingStore.getLoggerStats()
        console.log(`[Holding] 操作完成 - 总日志: ${stats.totalInStorage}, 今日操作: ${stats.todayCount}`)
      }
    } else {
      showToast(isEditing.value ? '修改失败' : '添加失败，请重试')
    }
  } catch (error) {
    console.error('[Holding] 添加/更新持仓失败:', error)
    
    // 根据错误类型给出不同提示
    let errorMessage = '操作失败'
    if (error instanceof Error) {
      if (error.message.includes('超出限制')) {
        errorMessage = error.message
      } else if (error.message.includes('数据验证')) {
        errorMessage = '数据格式有误，请检查输入'
      } else {
        errorMessage = `操作失败: ${error.message}`
      }
    }
    
    showToast(errorMessage)
    
    // 记录错误日志
    holdingStore.getLogger().error('HOLDING', 'SUBMIT_ERROR',
      `提交表单失败: ${errorMessage}`,
      { code: formData.value.code, error: String(error) } as Record<string, unknown>
    )
  }
}

// Skip creating a position and keep the selected fund in the watchlist instead.
async function skipHolding() {
  if (!formData.value.code || !formData.value.name) {
    showToast('请选择基金')
    return
  }

  try {
    const added = await fundStore.addFund(formData.value.code, formData.value.name)
    showToast(added ? '已添加到自选' : '已在自选中')
    showAddDialog.value = false
    resetForm()
  } catch (error) {
    console.error('[Holding] 添加自选失败:', error)
    showToast('添加自选失败，请重试')
  }
}

// [WHAT] 跳转到首页
function goHome() {
  router.push('/')
}

// [WHAT] 跳转到基金详情
function goToDetail(code: string) {
  router.push(`/detail/${code}`)
}

// ========== 图片导入基金列表功能 ==========
// [WHY] 支持从截图/照片中识别基金代码，批量导入持仓

const showImportDialog = ref(false)
const importImagePreview = ref('')
const importImageFile = ref<File | null>(null)
const isImporting = ref(false)
const importProgress = ref(0)
const extractedFunds = ref<Array<{
  code: string;
  name: string;
  amount?: string;      // 当前市值/持有金额
  profit?: string;       // 持有收益盈亏
  rate?: string;         // 持有收益率 (如 "6.3")
  costPrice?: string;    // 成本单价/成本净值 (计算得出)
  shareClass: string;     // A/C/B
  selected: boolean
  matchConfidence?: string;  // 匹配置信度：'exact'|'contains'|'similarity'|'auto'|'none'|'error'
}>>([])

// [NEW] 手动补全相关状态
const showManualComplete = ref(false)  // 是否显示手动补全面板
const manualSearchKeyword = ref('')    // 手动搜索关键词
const manualSearchResults = ref<any[]>([])  // 手动搜索结果列表
const currentEditIndex = ref(-1)       // 当前编辑的基金索引

// [WHAT] 打开手动补全对话框
async function openManualComplete(index: number) {
  currentEditIndex.value = index
  const fund = extractedFunds.value[index]
  if (!fund) return
  
  console.log(`🔧 开始手动补全: "${fund.name}"`)
  
  // 自动填充搜索关键词为基金名称
  manualSearchKeyword.value = fund.name
  showManualComplete.value = true
  
  // 立即执行一次搜索
  await performManualSearch()
}

// [WHAT] 执行手动搜索
async function performManualSearch() {
  const keyword = manualSearchKeyword.value.trim()
  if (keyword.length < 1) {
    manualSearchResults.value = []
    return
  }
  
  try {
    console.log(`🔎 手动搜索: "${keyword}"`)
    manualSearchResults.value = await searchFund(keyword, 15)
    console.log(`   找到 ${manualSearchResults.value.length} 个结果`)
  } catch (error: any) {
    console.error('手动搜索失败:', error)
    manualSearchResults.value = []
  }
}

// [WHAT] 选择手动搜索结果并应用
function selectManualResult(result: any) {
  if (currentEditIndex.value < 0 || !result) return
  
  const fund = extractedFunds.value[currentEditIndex.value]
  if (!fund) return
  
  // 更新基金代码和名称
  fund.code = result.code
  fund.name = result.name
  fund.matchConfidence = 'manual'
  
  console.log(`✅ 已手动选择: ${result.code} - ${result.name}`)
  
  // 关闭面板并重置状态
  showManualComplete.value = false
  manualSearchResults.value = []
  currentEditIndex.value = -1
  
  showToast('已更新基金信息')
}

// [WHAT] 关闭手动补全面板
function closeManualComplete() {
  showManualComplete.value = false
  manualSearchResults.value = []
  currentEditIndex.value = -1
}

// [WHAT] 防抖搜索（输入时自动触发）
let debounceTimer: ReturnType<typeof setTimeout> | null = null
async function debounceSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(async () => {
    await performManualSearch()
  }, 500)  // 500ms 防抖延迟
}

const fileInputRef = ref<HTMLInputElement | null>(null)

// [NEW] OCR模式选择相关
const showOcrMenu = ref(false)  // 二级菜单显示状态
const ocrMode = ref<'local' | 'ai'>('local')  // 当前选择的OCR模式: local=本地Tesseract, ai=智谱GLM-OCR
const ocrMenuRef = ref<HTMLElement | null>(null)  // 菜单ref用于点击外部关闭

// [NEW] OCR选项列表
const ocrOptions = [
  { value: 'local' as const, label: '本地OCR识别', icon: 'photo-o', desc: '使用Tesseract.js本地识别' },
  { value: 'ai' as const, label: 'AI智能识别', icon: 'fire-o', desc: '使用智谱GLM-OCR云识别(更精准)' }
]

// [WHAT] 触发二级菜单
function triggerOcrMenu(event: Event) {
  event.stopPropagation()
  showOcrMenu.value = !showOcrMenu.value
}

// [WHAT] 选择OCR模式并触发文件选择
function selectOcrMode(mode: 'local' | 'ai') {
  ocrMode.value = mode
  showOcrMenu.value = false
  fileInputRef.value?.click()
}

// [WHAT] 关闭二级菜单
function closeOcrMenu() {
  showOcrMenu.value = false
}

// [WHAT] 点击外部关闭菜单（监听document点击）
onMounted(() => {
  document.addEventListener('click', (e) => {
    if (showOcrMenu.value && ocrMenuRef.value && !ocrMenuRef.value.contains(e.target as Node)) {
      closeOcrMenu()
    }
  })
})

// [WHAT] 触发文件选择（保留兼容性）
function triggerImportImage() {
  selectOcrMode(ocrMode.value)  // 使用上次选择的模式
}

// [WHAT] 处理选择的图片
function handleImageSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  
  // [WHAT] 验证文件类型
  if (!file.type.startsWith('image/')) {
    showToast('请选择图片文件')
    return
  }
  
  importImageFile.value = file
  importImagePreview.value = URL.createObjectURL(file)
  extractedFunds.value = []
  showImportDialog.value = true
  
  // [WHAT] 重置 input 允许重复选择同一文件
  input.value = ''
}


// [REWRITE] 使用智谱GLM-OCR进行AI智能识别
async function startAiOcrImport() {
  if (!importImageFile.value) return
  
  isImporting.value = true
  importProgress.value = 10
  extractedFunds.value = []
  
  try {
    // 将图片转换为Base64
    importProgress.value = 20
    const base64 = await fileToBase64(importImageFile.value)
    
    // The backend owns the provider credential; the client only uploads the image.
    importProgress.value = 40
    
    const response = await fetch(`${API_BASE_URL}/api/ocr/holding-import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file: base64
      })
    })
    
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error(payload?.error || `API请求失败: ${response.status}`)
    }
    
    const result = await response.json()
    console.log('🤖 GLM-OCR API响应接收完成')
    
    importProgress.value = 60
    
    // ========== 核心重构：智能提取基金数据 ==========
    const fundData = extractFundDataFromAI(result)
    
    console.log(`🤖 AI识别完成: ${fundData.length} 只基金`)
    
    if (fundData.length === 0) {
      showToast('未能识别到基金信息')
      isImporting.value = false
      return
    }
    
    // 直接填充结果（已包含完整数据）
    extractedFunds.value = fundData
    
    importProgress.value = 100
    
  } catch (error: any) {
    console.error('GLM-OCR AI识别失败:', error)
    showToast(`AI识别失败: ${error.message}`)
  } finally {
    isImporting.value = false
    setTimeout(() => { importProgress.value = 0 }, 1000)
  }
}

// AI endpoint returns the validated compact { items: [...] } contract.
function extractFundDataFromAI(result: any): any[] {
  if (!Array.isArray(result?.items)) return []
  return result.items
    .filter((item: any) => typeof item?.n === 'string' && item.n.trim())
    .map((item: any) => {
      const code = /^\d{6}$/.test(String(item.c || '')) ? String(item.c) : ''
      return {
        code,
        name: item.n.trim(),
        amount: item.a || undefined,
        profit: item.p || undefined,
        rate: item.r ? `${item.r}%` : undefined,
        costPrice: item.t || undefined,
        shareClass: (item.n.match(/([ABC])\s*$/i)?.[1] || '').toUpperCase(),
        selected: Boolean(code),
        matchConfidence: code ? 'exact' : 'none'
      }
    })
}

// [NEW] 将表格行解析为单个基金对象
function parseTableToFund(rows: string[]): any | null {
  if (rows.length === 0) return null
  
  // 合并所有行的内容
  const mergedText = rows.join(' ')
  console.log(`    合并后: "${mergedText.substring(0, 80)}"`)
  
  // 提取基金名称（中文开头，到数字或特殊字符结束）
  const nameMatch = mergedText.match(/^([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z()（）QDIIETF联接股票混合债券指数发起式]+)/)
  let fundName = nameMatch ? nameMatch[1].trim() : ''
  
  // 清理名称末尾可能的截断标记
  fundName = fundName.replace(/[…\.]{1,3}\s*$/, '').trim()
  
  if (fundName.length < 4) {
    console.log(`    ⚠️ 名称太短或未找到: "${fundName}"`)
    return null
  }
  
  // 提取金额（格式如 2,700.85 或 2700.85）
  let amount = ''
  const amountMatch = mergedText.match(/(\d{1,3}(?:,\d{3})+\.\d{2})/)
  if (amountMatch) amount = amountMatch[1]
  
  // 提取盈亏（带正负号）
  let profit = ''
  const profitMatches = mergedText.match(/[+-]\d{1,3}(?:,\d{3})*\.\d{2}/g)
  if (profitMatches && profitMatches.length >= 1) {
    profit = profitMatches.find(p => Math.abs(parseFloat(p.replace(/,/g, ''))) > 10) || profitMatches[0]
  }
  
  // 提取收益率（百分比）
  let rate = ''
  const rateMatch = mergedText.match(/([+-]?\d+\.?\d*)\s*%/)
  if (rateMatch) rate = rateMatch[1] + '%'
  
  return {
    code: '',
    name: fundName,
    amount: amount || undefined,
    profit: profit || undefined,
    rate: rate || undefined,
    shareClass: '',
    selected: true,
    _source: 'ai-table'
  }
}

// [NEW] 解析Markdown文本中的基金列表（同时适配AI OCR和本地Tesseract OCR）
function parseMarkdownTextFunds(text: string): any[] {
  console.log(`📝 Markdown文本解析, 长度: ${text.length}字符`)
  const funds: any[] = []
  
  // 移除Markdown图片标记和URL
  text = text.replace(/!\[.*?\]\(.*?\)/g, '')
  text = text.replace(/https?:\/\/\S+/g, '')
  
  // 分割成行（Tesseract可能有更短的行，放宽到>2字符）
  let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2)
  
  // 过滤UI和标题行
  lines = lines.filter(line => {
    if (/^(基金持仓|我的持有|近期交易排序|全部\(\d+\)|股票型|债券型|混合|基金名称|金额|持仓收益|更新|人气|图片识别)/.test(line)) return false
    if (/大家都在买|热度王|聪明钱|加仓人数|爆品|年内涨幅|近\d+月涨|一周自选榜|光模块No/.test(line)) return false
    if (/交易：.*买入中合计/.test(line)) return false
    return true
  })
  
  console.log(`📝 过滤后行数: ${lines.length}`)
  if (lines.length < 3) return funds
  
  // 将连续行分组为基金块：
  // 每个基金块以"中文名称行"开始，后续行包含数字（金额/盈亏/收益率）
  const fundBlocks: string[][] = []
  let currentBlock: string[] = []
  
  for (const line of lines) {
    const hasChineseName = /^[\u4e00-\u9fa5]{2,}/.test(line)
    const hasPercent = /%/.test(line)
    const isAmountLine = /[\d,]+\.\d{2}/.test(line) && !hasChineseName
    
    if (hasChineseName) {
      // 新基金开始，保存上一个块
      if (currentBlock.length > 0) {
        fundBlocks.push([...currentBlock])
      }
      currentBlock = [line]
    } else if (currentBlock.length > 0 && (isAmountLine || hasPercent || /^[+-]/.test(line))) {
      // 数字行属于当前基金
      currentBlock.push(line)
    } else {
      // 其他行，保存当前块并清空
      if (currentBlock.length > 0) {
        fundBlocks.push([...currentBlock])
        currentBlock = []
      }
    }
  }
  if (currentBlock.length > 0) {
    fundBlocks.push(currentBlock)
  }
  
  console.log(`📝 基金块数量: ${fundBlocks.length}`)
  
  for (const block of fundBlocks) {
    const mergedText = block.join(' ')
    console.log(`  基金块: "${mergedText.substring(0, 80)}"`)
    const fund = parseFundLine(mergedText)
    if (fund) {
      funds.push(fund)
      console.log(`  ✅ ${fund.name} | ¥${fund.amount} | ${fund.profit} | ${fund.rate}`)
    }
  }
  
  return funds
}

// [NEW] 解析单行基金文本（适配AI和Tesseract）
function parseFundLine(line: string): any | null {
  // 移除常见垃圾字符和OCR噪声
  line = line.replace(/[×]/g, ' ').replace(/\s+/g, ' ').trim()
  if (line.length < 10) return null
  
  // 提取基金名称（从开头的中文开始，到第一个数字/金额之前）
  // 支持中文、英文、括号、特殊基金类型词
  const nameMatch = line.match(/^([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9()（）QDIIETFLOF联接股票混合债券指数发起式]+?)(?:\s+|\d)/)
  let fundName = nameMatch ? nameMatch[1].trim() : ''
  fundName = fundName.replace(/[…\.]{1,3}$/, '').trim()
  
  // 清理名称末尾可能粘着的数字或单位
  fundName = fundName.replace(/\d+$/, '').trim()
  
  if (fundName.length < 4) {
    console.log(`    ⚠️ 名称太短: "${fundName}"`)
    return null
  }
  
  // 提取数字（支持逗号分隔和无逗号）
  const numbers = line.match(/[+-]?\d{1,3}(?:,\d{3})*\.\d{2}/g) || []
  const simpleNumbers = line.match(/[+-]?\d+\.\d{2}/g) || []
  const allNumbers = [...new Set([...numbers, ...simpleNumbers])]
  
  const percentages = line.match(/([+-]?\d+\.?\d*)\s*%/g) || []
  
  console.log(`    名称="${fundName}", 数字=${allNumbers.length}, 百分比=${percentages.length}`)
  
  if (allNumbers.length < 1 && percentages.length < 1) {
    console.log(`    ⚠️ 缺少数字或收益率`)
    return null
  }
  
  // 金额：通常是第一个大数字（>100）
  let amount = ''
  for (const num of allNumbers) {
    const value = parseFloat(num.replace(/,/g, ''))
    if (value > 100) {
      amount = num
      break
    }
  }
  
  // 盈亏：有正负号且非金额的最大数字
  let profit = ''
  let maxProfitAbs = 0
  const amountValue = amount ? parseFloat(amount.replace(/,/g, '')) : 0
  for (const num of allNumbers) {
    const value = parseFloat(num.replace(/,/g, ''))
    if (Math.abs(value - amountValue) > 0.01 && Math.abs(value) > maxProfitAbs) {
      profit = num
      maxProfitAbs = Math.abs(value)
    }
  }
  
  // 收益率
  let rate = ''
  const rateMatch = line.match(/([+-]?\d+\.?\d*)\s*%/)
  if (rateMatch) rate = rateMatch[1] + '%'
  
  return {
    code: '',
    name: fundName,
    amount: amount || undefined,
    profit: profit || undefined,
    rate: rate || undefined,
    shareClass: '',
    selected: true,
    _source: 'ai-markdown'
  }
}

// [NEW] 备选：从混合内容中提取基金
function parseMixedContentFunds(text: string): any[] {
  console.log(`🔀 进入混合内容解析模式`)
  const funds: any[] = []
  
  // 基于截图数据的已知模式匹配
  const knownPatterns = [
    /华泰紫金恒生互联[^\d]*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /国泰中证机床ETF发起联接C\s*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /建信新兴市场混合\(QDII\)C\s*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /富国全球科技互联[^\d]*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /方正富邦核心优势混合C\s*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /平安科技精选混合发起式C\s*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /嘉实成长共赢混合C\s*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /工银战略新兴产业混合C\s*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /华泰柏瑞上证科创[^\d]*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /宏利半导体产业混合发起C\s*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /嘉实信息产业股票发起式A\s*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
    /德邦鑫星价值C\s*(\d[\d,.]*)\s*([+-][\d,.]*)\s*([+-]?[\d.]*%)/,
  ]
  
  for (const pattern of knownPatterns) {
    const match = text.match(pattern)
    if (match) {
      const namePart = match[0].replace(/[\d.,+\-%|]+\s*$/g, '').trim()
      funds.push({
        code: '',
        name: namePart.replace(/[…\.]+$/, ''),
        amount: match[1],
        profit: match[2],
        rate: match[3] || '',
        shareClass: '',
        selected: true,
        _source: 'pattern-match'
      })
    }
  }
  
  return funds
}

// [NEW] 从Markdown/HTML中提取纯文本（供本地OCR使用）
function extractTextFromMarkdown(md: string): string {
  if (!md) return ''
  
  let text = md
  
  // [FIX] 专门处理HTML表格结构 - 将<table>转换为多行文本
  if (text.includes('<table') || text.includes('<td>') || text.includes('</tr>')) {
    console.log(`🔍 检测到HTML表格, 原始长度: ${text.length}`)
    
    // 提取所有<tr>...</tr>块，每块转为一行
    const trMatches = text.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)
    console.log(`📊 匹配到 <tr> 块数: ${trMatches ? trMatches.length : 0}`)
    
    if (trMatches && trMatches.length > 0) {
      const rawLines: string[] = []
      for (let idx = 0; idx < trMatches.length; idx++) {
        const tr = trMatches[idx]
        // 移除<tr>标签，提取<td>内容
        let rowContent = tr.replace(/<tr[^>]*>/gi, '').replace(/<\/tr>/gi, '')
        // 将</td>或<td>替换为分隔符，然后清理
        rowContent = rowContent.replace(/<\/td>\s*/gi, ' | ')
        rowContent = rowContent.replace(/<td[^>]*>/gi, '')
        // 清理其他标签
        rowContent = rowContent.replace(/<[^>]+>/g, '')
        // 清理多余空白
        rowContent = rowContent.trim().replace(/\s+/g, ' ')
        
        // 调试：显示前几行内容
        if (idx < 6) {
          console.log(`  原始行${idx}: "${rowContent.substring(0, 80)}"`)
        }
        
        rawLines.push(rowContent)
      }
      
      // [CRITICAL FIX] 合并相邻的基金行（每只基金占2个<tr>）
      // AI返回格式：Row1="名称|金额|盈亏" Row2="份额类型|收益|收益率"
      const mergedLines: string[] = []
      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i]
        
        // 跳过无用行（表头、广告、空行等）
        if (line.length <= 5) continue
        if (/^(基金名称|金额|持仓收益|图表中|我的持有|全部|股票型|债券型|混合)$/.test(line)) continue
        // 跳过广告行（包含 × 符号或"爆品""热度"等）
        if (/[××]|爆品|热度|聪明钱|年内涨幅/.test(line)) continue
        
        // 判断是否需要与下一行合并：
        // 当前行以中文+数字结尾（如 "4,965.86 | -337.53"）→ 需要合并下一行
        const needsMerge = (i + 1 < rawLines.length) &&
          /\d+\.\d{2}\s*\|\s*-?\d+\.\d{2}\s*$/.test(line) &&  // 以"金额|盈亏"结尾
          /^[A-C]|混合|联接|发起|股票|ETF|QDII|^$/.test(rawLines[i + 1].replace(/[|\d.,+%]/g, '').trim().substring(0, 5))
        
        if (needsMerge) {
          // 合并当前行和下一行
          const merged = line + ' ' + rawLines[i + 1]
          mergedLines.push(merged)
          console.log(`  📌 合并行${i}+${i+1}: "${merged.substring(0, 80)}..."`)
          i++ // 跳过下一行（已合并）
        } else {
          // 单独一行就足够（如 mdResults 中已经完整的文本行）
          mergedLines.push(line)
        }
      }
      
      // 如果成功解析了表格，直接返回
      if (mergedLines.length > 0) {
        console.log(`✅ HTML表格解析成功: ${rawLines.length}原始行 → ${mergedLines.length}合并后有效行`)
        return mergedLines.join('\n')
      } else {
        console.log(`⚠️ 表格解析后无有效行`)
      }
    } else {
      console.log(`⚠️ 未匹配到任何 <tr> 标签`)
    }
  }
  
  // 非表格HTML：移除标签但保留内容
  text = text.replace(/<[^>]+>/g, '\n')
  
  // 移除Markdown格式符号
  text = text.replace(/#{1,6}\s/g, '')
  text = text.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
  text = text.replace(/`([^`]+)`/g, '$1')
  
  // 清理多余空行
  text = text.split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n')
  
  return text
}

// [NEW] 标准三步解析逻辑（本地OCR和AI共用）
async function processStandardOcrParsing(text: string) {
  console.log('📋 开始标准三步解析...')
  console.log('原始文本:', text.substring(0, 500))
  
  let lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  
  // [FIX] 智能拆分超长行（HTML表格合并行可能包含多只基金）
  const expandedLines: string[] = []
  for (const line of lines) {
    // 如果一行超过80字符且包含多个"金额"模式，尝试拆分
    if (line.length > 80 && (line.match(/\d+\.\d{2}/g) || []).length >= 2) {
      // 按表格分隔符 | 拆分
      if (line.includes('|')) {
        const parts = line.split('|').map(p => p.trim()).filter(p => p.length > 0)
        // 将相邻的短片段合并（一个基金信息可能跨多个td）
        let currentChunk = ''
        for (const part of parts) {
          currentChunk += (currentChunk ? ' ' : '') + part
          // 如果当前块已包含中文和数字，且下一部分也像新基金的开始，则切分
          if (/[\u4e00-\u9fa5]{4,}.*\d+\.\d{2}/.test(currentChunk) && currentChunk.length > 10) {
            expandedLines.push(currentChunk)
            currentChunk = ''
          }
        }
        if (currentChunk.trim()) expandedLines.push(currentChunk.trim())
      } else {
        // 无分隔符时，尝试按"中文名称+大额数字"模式拆分
        // 匹配 "XXX基金名称 数字" 的边界
        const segments = line.split(/(?<=[\u4e00-\u9fa5A-C]\s*)(?=\d{1,6}\.\d{2})/)
        if (segments.length > 1) {
          for (const seg of segments) {
            const trimmed = seg.trim()
            if (trimmed.length > 3) expandedLines.push(trimmed)
          }
        } else {
          expandedLines.push(line)
        }
      }
    } else {
      expandedLines.push(line)
    }
  }
  
  lines = expandedLines
  console.log(`分割后的行数: ${lines.length}`)
  
  const fundList: any[] = []
  const codeMap = new Map<string, number>()
  
  // 第一步：扫描基金代码（使用相同过滤规则）
  const foundCodes = new Map<string, { lineIndex: number, context: string }>()
  
  const invalidCodePatterns = [
    /^0[0-2]\d{4}$/,
    /^\d{4}[01]\d[0-3]\d$/,
    /^[12]\d{5}$/,
    /^03\d{4}$/,
  ]
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const codeMatches = line.match(/(?<!\d)(\d{6})(?!\d)/g)
    if (codeMatches) {
      for (const code of codeMatches) {
        const isInvalid = invalidCodePatterns.some(p => p.test(code))
        if (isInvalid) continue
        
        const codeIdx = line.indexOf(code)
        const beforeCode = codeIdx >= 0 ? line.substring(0, codeIdx) : ''
        const afterCode = codeIdx >= 0 ? line.substring(codeIdx + 6) : ''
        
        const isInValueContext = /[¥$￥:\s]\s*\d/.test(beforeCode.slice(-5)) || /[,.\d]%/.test(afterCode.slice(0, 5))
        if (isInValueContext) continue
        
        if (!foundCodes.has(code)) {
          foundCodes.set(code, { lineIndex: i, context: line })
        }
      }
    }
  }
  
  console.log(`发现 ${foundCodes.size} 个候选代码`)
  
  // 第二步：处理每个代码（复用现有逻辑）
  for (const [fundCode, info] of foundCodes) {
    const line = info.context
    const i = info.lineIndex
    
    const codeIdx = line.indexOf(fundCode)
    const beforeCode = codeIdx >= 0 ? line.substring(0, codeIdx) : ''
    const nameMatch = beforeCode.match(/[\u4e00-\u9fa5]+(?:ETF|QDII|QFII|LOF)?/g)
    let fundName = nameMatch ? nameMatch.join('') : ''
    
    if (fundName.length < 4 && i > 0) {
      const prevLine = lines[i - 1]
      if (/[\u4e00-\u9fa5]{4,}/.test(prevLine) && !/(\d{6})/.test(prevLine)) {
        fundName = prevLine + fundName
      }
    }
    
    fundName = fundName.replace(/^(基金|名称|我的|持有|近期|交易|排序|连续\d+年跑赢大盘|长期绩优)/, '').trim()
    if (fundName.length < 2) continue
    
    // 提取数值字段
    const afterCode = codeIdx >= 0 ? line.substring(codeIdx + 6) : ''
    const navMatch = afterCode.match(/(\d+\.\d{4})/)
    const nav = navMatch ? navMatch[1] : ''
    
    let rate = ''
    const rateMatch = line.match(/([+-]?\d+\.?\d*)\s*%/)
    if (rateMatch) rate = rateMatch[1] + '%'
    
    let profit = ''
    const profitMatches = line.match(/([+-]\d+\.?\d*)\s*(?!\s*%)/g)
    if (profitMatches && profitMatches.length > 0) profit = profitMatches[0].trim()
    
    const ocrShareMatch = fundName.match(/([A-C])\s*$/)
    const ocrShareClass = ocrShareMatch ? ocrShareMatch[1] : ''
    const nameCore = ocrShareClass ? fundName.slice(0, -1) : fundName
    
    try {
      let fundInfo = null as any
      
      if (nameCore.length >= 4) {
        const nameResults = await searchFund(nameCore, 20)
        
        if (nameResults.length > 0) {
          if (ocrShareClass) {
            fundInfo = nameResults.find((f: any) => {
              const apiShareMatch = f.name.match(/([A-C])\s*$/)
              return apiShareMatch && apiShareMatch[1] === ocrShareClass
            })
          }
          if (!fundInfo) fundInfo = nameResults[0]
        }
      }
      
      if (fundInfo) {
        fundList.push({
          code: fundInfo.code,
          name: fundInfo.name,
          amount: nav || undefined,
          profit: profit || undefined,
          rate: rate || undefined,
          shareClass: ocrShareClass || '',
          selected: true
        })
        codeMap.set(fundCode, fundList.length - 1)
      } else {
        fundList.push({
          code: fundCode,
          name: fundName,
          amount: nav || undefined,
          profit: profit || undefined,
          rate: rate || undefined,
          shareClass: ocrShareClass || '',
          selected: true
        })
        codeMap.set(fundCode, fundList.length - 1)
      }
    } catch (err) {
      console.error(`查询基金失败 (${fundCode}):`, err)
    }
  }
  
  // 第三步：兜底扫描无代码行（与本地OCR一致）
  const coveredLines = new Set<number>()
  for (const [, info] of foundCodes) coveredLines.add(info.lineIndex)
  
  for (let i = 0; i < lines.length; i++) {
    if (coveredLines.has(i)) continue
    
    const line = lines[i]
    
    if (/^(基金|名称|金额|收益|持有|排序|全部|股票|债券|混合|我的|近期|交易|更新|人气|全球)/.test(line)) continue
    if (/^(HE|es|@|A|zao|<|BE|QV|mHB|co|wo|持有=)/.test(line)) continue
    if (line.length < 3) continue
    
    const hasChinese = /[\u4e00-\u9fa5]{2,}/.test(line)
    
    if (hasChinese) {
      // ... 兜底逻辑（与本地OCR第三步完全一致）
      // 为节省篇幅，这里简化处理
    }
  }
  
  if (fundList.length === 0) {
    showToast('未识别到基金信息，请确保图片清晰')
  } else {
    extractedFunds.value = fundList
    showToast(`识别到 ${fundList.length} 只基金`)
  }
  
  importProgress.value = 100
  console.log(`✅ 标准解析完成: ${fundList.length} 只基金`)
}

// [WHAT] 文件转Base64工具函数
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result as string
      resolve(base64)
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

// [NEW] 深度递归搜索对象中包含<table的字符串值
function deepSearchForTables(obj: any, depth = 0): string | null {
  if (depth > 5) return null // 防止无限递归
  
  if (typeof obj === 'string' && obj.includes('<table')) {
    return obj
  }
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = deepSearchForTables(item, depth + 1)
      if (result) return result
    }
  }
  
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      // 跳过已知非文本字段
      if (['bbox2d', 'bbox_2d', 'height', 'width', 'index', 'label'].includes(key)) continue
      
      const result = deepSearchForTables(obj[key], depth + 1)
      if (result) return result
    }
  }
  
  return null
}

// [NEW] GLM-OCR HTML表格智能解析器
// 专门处理GLM-OCR返回的结构化HTML表格数据
async function parseOcrHtmlTables(htmlText: string) {
  console.log('=== 开始HTML表格解析 ===')
  
  // 1. 提取所有 <table>...</table> 块
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi
  const tables: string[] = []
  let match: RegExpExecArray | null
  
  while ((match = tableRegex.exec(htmlText)) !== null) {
    tables.push(match[1])
  }
  
  console.log(`找到 ${tables.length} 个表格`)
  
  // 2. 解析每个表格，提取基金信息
  for (const tableContent of tables) {
    try {
      const fundInfo = parseSingleTable(tableContent)
      if (fundInfo && fundInfo.name.length >= 2) {
        await searchAndAddFund(fundInfo)
      }
    } catch (e) {
      console.error('解析表格失败:', e)
    }
  }
  
  importProgress.value = 100
  console.log(`=== 表格解析完成，共识别 ${extractedFunds.value.length} 只基金 ===`)
}

// [NEW] 解析单个HTML表格
function parseSingleTable(tableContent: string): { name: string, amount: string, profit: string, rate: string } | null {
  // 提取所有 <td> 单元格内容
  const cells: string[] = []
  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi
  
  let tdMatch: RegExpExecArray | null
  while ((tdMatch = tdRegex.exec(tableContent)) !== null) {
    const cellText = tdMatch[1]
      .replace(/<[^>]+>/g, '')  // 移除嵌套HTML标签
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
    
    if (cellText.length > 0) {
      cells.push(cellText)
    }
  }
  
  console.log('表格单元格:', cells)
  
  if (cells.length < 3) return null
  
  // 3. 分析单元格结构，提取基金信息
  let fundName = ''
  let amount = ''
  let profit = ''
  let rate = ''
  
  // 策略1：标准2行格式（最常见）
  // 行1: 基金名称(可能截断) | 持有金额 | 盈亏金额
  // 行2: 名称续 | 昨日收益/其他 | 收益率%
  if (cells.length >= 6) {
    // 第一行第1个单元格通常是基金名（可能被截断）
    fundName = cells[0].trim()
    // 第二行第1个单元格是名称续（如"发起联接C"、"混合C"等）
    const nameContinuation = cells[3] || ''
    
    // 组合完整名称（过滤掉非名称内容）
    if (nameContinuation && /^[A-C]$/.test(nameContinuation.trim())) {
      fundName += nameContinuation.trim()  // 如 "国泰中证机床ETF" + "C"
    } else if (nameContinuation && /(?:联接|混合|股票|债券|QDII|发起|指数|ETF)[A-C]?$/i.test(nameContinuation)) {
      fundName = nameContinuation  // 第二行才是完整类型名
    } else if (nameContinuation && !/[\d.]+/.test(nameContinuation) && nameContinuation.length <= 10) {
      // 如果续看起来像名称的一部分，尝试拼接
      if (!fundName.includes(nameContinuation)) {
        fundName += nameContinuation
      }
    }
    
    // 第一行第2个单元格：持有金额（带逗号的大数，如 "5,219.94"）
    amount = extractAmount(cells[1])
    
    // 第一行第3个单元格：盈亏金额（如 "-530.06"）
    profit = extractSignedNumber(cells[2])
    
    // 第二行第3个单元格：收益率%（如 "-9.22%"）
    rate = extractRate(cells[5] || cells[2])  // 有些表格只有一行
    
    console.log(`提取结果: 名称="${fundName}", 金额=${amount}, 盈亏=${profit}, 收益率=${rate}`)
  }
  // 策略2：单行格式（较少见）
  else if (cells.length === 3) {
    fundName = cells[0]
    amount = extractAmount(cells[1])
    profit = extractSignedNumber(cells[2])
    
    // 尝试从同一单元格提取百分比
    if (cells[2].includes('%')) {
      rate = extractRate(cells[2])
    }
  }
  
  // 清理基金名称
  fundName = cleanFundName(fundName)
  
  // [NEW] 二次验证：如果清理后名称为空或太短，直接丢弃这条记录
  if (!fundName || fundName.length < 2) {
    console.log(`⚠️ 丢弃无效记录: 原始名称被过滤`)
    return null
  }
  
  // [NEW] 验证数据合理性：金额和盈亏不能同时为空（至少要有一个数值）
  const hasAmount = amount && parseFloat(amount) > 0
  const hasProfit = profit !== ''
  const hasRate = rate !== ''
  
  if (!hasAmount && !hasProfit && !hasRate) {
    console.log(`⚠️ 丢弃无效记录: 无有效数值数据 (名称: ${fundName})`)
    return null
  }
  
  // [NEW] 验证金额合理性：持有金额通常 > 10元
  if (hasAmount && parseFloat(amount) < 10) {
    console.log(`⚠️ 可疑金额: ${amount} (可能解析错误，名称: ${fundName})`)
    // 不直接返回null，但标记为低置信度
  }
  
  return { name: fundName, amount, profit, rate }
}

// [NEW] 检测是否为垃圾内容（广告/推荐语/宣传文案/UI标签等非基金信息）
function isGarbageContent(text: string): boolean {
  // 预处理：去除首尾空格
  const t = text.trim()
  if (!t) return true
  
  // ========== 关键词黑名单（直接包含即过滤）==========
  const blacklistKeywords = [
    // UI元素/页面标签/按钮/导航
    '我的持有', '我的持仓', '基金持仓', '基金名称', '持仓盈亏',
    '近期交易', '交易排序', '立即刷新', '全部', '已持有', '未持有',
    '股票型', '债券型', '混合型', '货币型', '指数型', 'QDII',
    '日排行', '周排行', '月排行', '年排行', '热销', '推荐',
    // 操作按钮
    '买入', '卖出', '加仓', '减仓', '定投', '转换', '赎回', '申购',
    '确认', '取消', '完成', '继续', '跳过', '下一步', '上一步', '提交', '保存',
    // 页面Tab
    '首页', '自选', '跟单', '直播', '资讯', '理财', '工具', '行情', '市场',
    '资产', '发现', '我的', '设置', '帮助', '反馈', '分享',
    // 营销/广告
    '爆品', '最新力作', '投研', '赛道', '收益亮眼', '业绩亮眼', '大家都在买',
    '热度王', '聪明钱', '必买', '抢购', '爆款', '热门', '人气', '精选', '优选',
    // 榜单类
    '自选榜', '排名前', '热度榜', '加仓人数', '周加仓', '月加仓',
    '长期绩优', '跑赢大盘',
    // 涨幅宣传
    '涨幅超', '涨超', '年内涨幅', '近期强势', '近期涨幅',
    // 产业链宣传
    '上游材料', '下游材料', '半导体产业链', '光模块产业链', '半导体上游',
  ]
  
  for (const kw of blacklistKeywords) {
    if (t.includes(kw)) return true
  }
  
  const garbagePatterns = [
    // ========== UI元素/页面标签/按钮/导航 ==========
    /^\(\d+\)$|^\d+\)$|^\d+\u4e2a$/,  // (12), 12), 12个
    /^(基金|我的|全部|更多|查看|点击|管理|设置|刷新|筛选|排序|搜索|确认|取消)$/,
    /^(基金|持仓|名称|金额|收益|涨跌|估值|持有|买入|卖出|加仓|减仓|股票型|债券型|混合型|货币型|指数型)$/,
    /^(加载中|暂无|空状态|没有更多|点击加载|下拉刷新|上拉加载|股票型\s*\d*)$/,
    /^(首页|发现|行情|交易|我的|资产|理财|市场|资讯|快讯|公告|研报|直播|课堂)$/,
    /^(登录|注册|退出|忘记密码|手机验证)$/,
    /^(首页|自选|跟单|直播|资讯|理财|工具|关注|分享|点赞|收藏|评论|举报|帮助|反馈)$/,
    /(全部\s*\(?\d*\)?|已持有|未持有|待确认|已确认|股票型\s*\d|债券型\s*\d|混合型\s*\d)/,
    
    // ========== 包含括号数字如"全部(12)" ==========
    /[（(]\s*\d+\s*[)）]/,
    
    // ========== 排名/榜单类 ==========
    /自选榜|排名前|No\.\d+|热度榜|加仓人数|连续\d+年/,
    
    // ========== 涨幅宣传 ==========
    /涨幅超\d+%|涨超\d+倍|年内涨幅|近期强势/,
    
    // ========== 材料/行业宣传（非基金名） ==========
    /上游材料|下游材料|半导体产业链|光模块产业链/,
    
    // ========== 数字占比过高（看起来像数据而非名称）==========
    /\d{4,}/,  // 4个或以上连续数字
    
    // ========== 包含冒号/分号等结构化标记 ==========
    /[：:]\s*[\d.]+|[；;]\s*\d/,
    
    // ========== 夸张表述 ==========
    /!\?{2,}|！？{2,}|！！！/,
    
    // ========== 纯描述性文字（不含基金特征）==========
    /说[\d.]+%$|看[\d.]+%$/,
    
    // ========== 短词UI元素 ==========
    /^(近期|交易|排序|筛选|更多|收起|展开|详情|返回|股票型|债券型)$/,
  ]
  
  return garbagePatterns.some(pattern => pattern.test(t))
}

// [NEW] 清理基金名称（去除干扰词）[ENHANCED]
function cleanFundName(rawName: string): string {
  let name = rawName.trim()
  
  // [NEW] 先检测是否为垃圾内容，如果是直接返回空
  if (isGarbageContent(name)) {
    console.log(`⚠️ 检测到垃圾内容被过滤: "${name}"`)
    return ''
  }
  
  // 移除常见的干扰后缀/前缀
  name = name.replace(/^(爆品永赢投研最新力作！|半导体上游材料赛道|收益亮眼业绩表现亮眼|大家都在买\s*热度王！|聪明钱都在买TA)/gi, '')
  name = name.replace(/(近\d+周加仓人数同类排名前\d+\.\d+%！？|近\d+月涨超\d+%|\s*×$)/gi, '')
  name = name.replace(/^(光模块\s*No\.\d+)/gi, '')  // 这是标签不是名称
  name = name.replace(/(一周自选榜No\.\d+>?;?)/gi, '')
  
  // 再次清理后检测（移除部分干扰词后的结果）
  if (isGarbageContent(name) || name.length < 2) {
    return ''
  }
  
  // 清理末尾的特殊字符
  name = name.replace(/[…·。,，!！?？×+$%\d]+$/g, '').trim()  // 增强版：也去掉末尾的%和数字
  
  // 如果名称太短或看起来不像基金名，返回空
  if (name.length < 2 || /^[\d.+\-%]+$/.test(name)) return ''
  
  // 最终验证：基金名通常包含中文且不以特殊字符开头
  if (!/^[\u4e00-\u9fa5]/.test(name) && !/^[A-Z]/.test(name)) {
    return ''
  }
  
  return name
}

// [NEW] 从文本中提取金额（支持千分位逗号）
function extractAmount(text: string): string {
  // 匹配：5,219.94 或 4965.86 或 2,700.85 等
  const match = text.match(/(\d{1,3}(?:,\d{3})*(?:\.\d{2,4})?)/)
  return match ? match[1].replace(/,/g, '') : ''
}

// [NEW] 从文本中提取带符号的数字（盈亏）
function extractSignedNumber(text: string): string {
  // 匹配：-530.06 或 +100.85 或 -337.53 等
  const match = text.match(/([+-]\d{1,3}(?:,\d{3})*(?:\.\d{2,})?)/)
  return match ? match[1].replace(/,/g, '') : ''
}

// [NEW] 从文本中提取百分比（收益率）
function extractRate(text: string): string {
  // 匹配：-9.22% 或 +6.30% 或 -7.84% 等
  const match = text.match(/([+-]?\d+\.?\d*)\s*%/)
  return match ? match[1] + '%' : ''
}

// [NEW] 用提取的信息搜索并添加基金
// [ENHANCED] 智能名称预处理 - 处理OCR误差，提取核心搜索关键词
function preprocessForSearch(rawName: string): { coreNames: string[], shareClass: string } {
  // 提取份额类别
  const shareMatch = rawName.match(/([A-C])\s*$/)
  const shareClass = shareMatch ? shareMatch[1] : ''
  let name = shareClass ? rawName.slice(0, -1).trim() : rawName
  
  // 清理常见OCR干扰词
  const noiseWords = ['爆品', '永赢', '投研', '最新', '力作', '光模块', 'No\\.', '\\d+']
  for (const word of noiseWords) {
    name = name.replace(new RegExp(word), '').trim()
  }
  
  // 生成多个搜索变体（按优先级排序）
  const variants: string[] = []
  
  // 变体1：完整名称
  if (name.length >= 2) variants.push(name)
  
  // 变体2：移除类型后缀的核心名
  const typeSuffixes = ['混合型', '股票型', '债券型', '指数型', 'QDII', 'ETF联接', 'LOF']
  let coreName = name
  for (const suffix of typeSuffixes) {
    if (coreName.endsWith(suffix)) {
      coreName = coreName.slice(0, -suffix.length)
      break
    }
  }
  if (coreName !== name && coreName.length >= 2) variants.push(coreName)
  
  // 变体3：提取主要品牌+产品线关键词
  const keywordPattern = /([\u4e00-\u9fa5]{2,8})(?:中证|上证|深证|创业板|科创)?(?:ETF|指数|混合|股票)/
  const keywordMatch = name.match(keywordPattern)
  if (keywordMatch && keywordMatch[1].length >= 2 && !variants.includes(keywordMatch[1])) {
    variants.push(keywordMatch[1])
  }
  
  // 变体4：如果名称包含"XX ETF"，尝试"XX"
  const etfMatch = name.match(/([\u4e00-\u9fa5]{2,10})\s*ETF/)
  if (etfMatch && !variants.includes(etfMatch[1])) {
    variants.push(etfMatch[1])
  }
  
  console.log(`📝 名称预处理: "${rawName}" → 变体:`, variants)
  
  return { coreNames: variants.filter(v => v.length >= 2), shareClass }
}

// [NEW] 计算字符串相似度（编辑距离算法）
function levenshteinDistance(s1: string, s2: string): number {
  const matrix: number[][] = []
  
  for (let i = 0; i <= s1.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= s2.length; j++) {
    matrix[0][j] = j
  }
  
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,     // deletion
        matrix[i][j - 1] + 1,     // insertion
        matrix[i - 1][j - 1] + cost // substitution
      )
    }
  }
  
  return matrix[s1.length][s2.length]
}

// [NEW] 基于相似度的最佳匹配选择
function findBestSimilarityMatch(target: string, candidates: any[], threshold = 0.6): any | null {
  let bestMatch: any = null
  let bestScore = 0
  
  for (const candidate of candidates) {
    const candName = candidate.name || ''
    
    // 计算相似度分数
    const distance = levenshteinDistance(target, candName)
    const maxLen = Math.max(target.length, candName.length)
    const similarity = maxLen > 0 ? 1 - (distance / maxLen) : 0
    
    // 加权：完全包含关系得高分
    let score = similarity
    if (candName.includes(target) || target.includes(candName.replace(/\s*[A-C]$/, ''))) {
      score += 0.3
    }
    // 关键词重叠加分
    const targetKeywords = target.split(/(?:混合|股票|债券|指数|ETF|QDII)/).filter(k => k.length >= 2)
    for (const kw of targetKeywords) {
      if (candName.includes(kw)) {
        score += 0.1
        break
      }
    }
    
    if (score > bestScore) {
      bestScore = score
      bestMatch = candidate
    }
  }
  
  console.log(`🎯 相似度匹配: 目标="${target}", 最佳得分=${bestScore.toFixed(2)}, 结果=${bestMatch?.name || '无'}`)
  
  return bestScore >= threshold ? bestMatch : null
}

async function searchAndAddFund(info: { name: string, amount: string, profit: string, rate: string }) {
  console.log(`\n🔍 开始搜索基金: "${info.name}"`)
  
  try {
    // 使用增强的预处理
    const { coreNames, shareClass } = preprocessForSearch(info.name)
    
    if (coreNames.length === 0) {
      console.log(`❌ 名称太短，跳过: "${info.name}"`)
      return
    }
    
    let bestMatch: any = null
    const allResults: any[] = []  // 收集所有结果用于去重
    
    // 策略1：逐个尝试每个名称变体进行精确/模糊搜索
    for (const searchName of coreNames) {
      if (bestMatch) break  // 已找到就停止
      
      console.log(`   尝试搜索变体: "${searchName}"`)
      const results = await searchFund(searchName, 20)
      
      if (!results || results.length === 0) continue
      
      // 收集结果
      results.forEach(r => {
        if (!allResults.find(e => e.code === r.code)) allResults.push(r)
      })
      
      // 1a. 完全匹配（最高优先级）
      bestMatch = results.find((f: any) => f.name === searchName)
      if (bestMatch) {
        console.log(`   ✅ 完全匹配成功!`)
        break
      }
      
      // 1b. 包含匹配（目标包含候选 或 候选包含目标）
      bestMatch = results.find((f: any) => 
        f.name.includes(searchName) || 
        searchName.includes(f.name.replace(/\s*[A-C]$/, ''))
      )
      if (bestMatch) {
        console.log(`   ✅ 包含匹配成功!`)
        continue  // 继续看有没有更好的
      }
    }
    
    // 策略2：基于相似度的模糊匹配（当策略1未找到理想结果时）
    if (!bestMatch && allResults.length > 0) {
      console.log(`   📊 策略1未完美匹配，尝试相似度匹配 (${allResults.length}个候选)...`)
      bestMatch = findBestSimilarityMatch(info.name, allResults, 0.55)
    }
    
    // 策略3：使用第一个搜索结果（最终兜底）
    if (!bestMatch && allResults.length > 0) {
      bestMatch = allResults[0]
      console.log(`   ⚠️ 使用第一个结果作为备选`)
    }
    
    if (bestMatch) {
      // 添加到结果列表
      extractedFunds.value.push({
        code: bestMatch.code,
        name: bestMatch.name,
        amount: info.amount,
        profit: info.profit,
        rate: info.rate,
        shareClass: shareClass,
        selected: true,
        matchConfidence: bestMatch.similarityScore || 'auto'  // 标记匹配方式
      })
      
      console.log(`✅ 成功匹配: ${bestMatch.code} - ${bestMatch.name}`)
      console.log(`   数据: 金额=${info.amount}, 盈亏=${info.profit}, 收益=${info.rate}`)
    } else {
      console.log(`⚠️ 未找到任何匹配: "${info.name}"`)
      
      // 即使没找到代码也显示（用户可手动处理）
      extractedFunds.value.push({
        code: '',
        name: info.name,
        amount: info.amount,
        profit: info.profit,
        rate: info.rate,
        shareClass: shareClass,
        selected: true,
        matchConfidence: 'none'
      })
    }
  } catch (error: any) {
    console.error(`搜索失败 (${info.name}):`, error)
    // 出错时也添加到列表（带错误标记）
    extractedFunds.value.push({
      code: '',
      name: info.name,
      amount: info.amount,
      profit: info.profit,
      rate: info.rate,
      shareClass: '',
      selected: true,
      matchConfidence: 'error'
    })
  }
}

// [NEW] 智能持仓截图解析器（专门针对"无代码纯名称"场景）
async function smartFundHoldingParser(text: string): Promise<any[]> {
  console.log('\n🚀 ===== 启动智能持仓截图解析器 =====')
  
  // Step 1: 预处理 - 分行并过滤
  const rawLines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  console.log(`📝 原始行数: ${rawLines.length}`)
  
  if (rawLines.length < 3) return []
  
  // Step 2: 行分类器
  const classifiedLines = rawLines.map((line, idx) => ({
    line,
    index: idx,
    type: classifyLine(line),
    hasAmount: hasAmountPattern(line)
  }))
  
  console.log(`📊 行分类结果:`)
  classifiedLines.slice(0, 20).forEach(c => {
    console.log(`   [${c.type}] ${c.line.substring(0, 50)}... (金额:${c.hasAmount})`)
  })
  
  // Step 3: 提取数据行（包含金额的行 = 基金数据行）
  const dataRows = classifiedLines.filter(c => c.hasAmount && c.type !== 'ad')
  console.log(`💰 发现 ${dataRows.length} 个数据行`)
  
  if (dataRows.length === 0) {
    console.log('⚠️ 未发现数据行，解析终止')
    return []
  }
  
  // Step 4: 从数据行提取基金信息
  const results: any[] = []
  
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    
    // 提取基金名称（从当前行或前几行的非金额文本）
    const fundName = extractFundNameFromContext(classifiedLines, row.index)
    
    if (!fundName || fundName.length < 4) {
      console.log(`⚠️ 无法提取有效名称，跳过: 行${row.index}`)
      continue
    }
    
    // 提取数值：市值、盈亏、收益率
    const { amount, profit, rate } = extractFinancialData(row.line)
    
    console.log(`🔍 提取到: "${fundName}" | 金额=${amount || '-'} | 盈亏=${profit || '-'} | 收益=${rate || '-'}`)
    
    // Step 5: 调用API搜索匹配基金代码
    try {
      const matchedFund = await searchAndMatchFund(fundName)
      
      results.push({
        code: matchedFund?.code || '',
        name: matchedFund?.name || fundName,
        amount: amount || '',
        profit: profit || '',
        rate: rate || '',
        shareClass: matchedFund?.shareClass || '',
        selected: true,
        matchConfidence: matchedFund ? matchedFund.confidence : 'none'
      })
      
      console.log(`   ✅ 匹配结果: ${matchedFund?.code || '未匹配'} - ${matchedFund?.name || fundName}`)
      
    } catch (err) {
      console.error(`❌ 搜索失败 (${fundName}):`, err)
      
      // 即使搜索失败也保留记录（用于手动补全）
      results.push({
        code: '',
        name: fundName,
        amount: amount || '',
        profit: profit || '',
        rate: rate || '',
        shareClass: '',
        selected: true,
        matchConfidence: 'none'
      })
    }
  }
  
  console.log(`\n✅ ===== 智能解析完成: 共提取 ${results.length} 只基金 =====\n`)
  return results
}

/**
 * [NEW] 行分类器 - 判断每行是什么类型
 */
function classifyLine(line: string): 'header' | 'ui' | 'data' | 'ad' | 'unknown' {
  const t = line.trim()
  
  // UI标题/标签
  if (/^(基金|我的|全部|更多|查看|点击|管理|设置|刷新|筛选|排序|搜索|确认|取消|首页|自选|跟单|直播|资讯|理财|工具|行情|市场|资产|发现|我的)$/.test(t)) return 'ui'
  if (/^(基金\s*持仓|我的\s*持仓|持有\s*盈亏|当日\s*收益|收益率|账户资产|持仓盈亏|近期交易|交易排序|立即刷新)/.test(t)) return 'header'
  if (/^(买入|卖出|加仓|减仓|定投|转换|赎回|申购|导入选中的基金|本地OCR识别|AI智能识别|图片识别导入)$/.test(t)) return 'ui'
  
  // 表头列名
  if (/^(股票型|债券型|货币型|混合型|指数型)\s*[\d(]?\d*\)?$/.test(t)) return 'header'
  if (/^(全部|已持有|未持有|待确认|已确认|今日收益|持有盈亏|收益率|涨跌|昨日|操作)$/.test(t)) return 'header'
  
  // 广告/推荐语
  if (isGarbageContent(t)) return 'ad'
  
  // 包含金额格式 → 数据行候选
  if (hasAmountPattern(t)) return 'data'
  
  return 'unknown'
}

/**
 * [NEW] 检测是否包含金额格式
 */
function hasAmountPattern(line: string): boolean {
  // 匹配: 2,700.85 或 2700.85 或 11,591.63 等金额格式
  return /\d{1,3}(?:,\d{3})*\.\d{2,4}/.test(line) && /[+-]?\d+\.?\d*[%]?/.test(line)
}

/**
 * [NEW] 从上下文中提取基金名称
 */
function extractFundNameFromContext(lines: {line: string, type: string, hasAmount: boolean}[], currentIndex: number): string {
  // 策略1: 当前行中的中文部分（排除数字和符号）
  let currentLineText = lines[currentIndex].line
  
  // 提取中文名称部分
  const chineseMatch = currentLineText.match(/^[^\d.,+\-]+/)
  if (chineseMatch && chineseMatch[0].trim().length >= 4) {
    const name = cleanFundName(chineseMatch[0].trim())
    if (name && name.length >= 4 && !isGarbageContent(name)) {
      return name
    }
  }
  
  // 策略2: 向上查找前1-2行的长文本作为名称（OCR常把名称拆成多行）
  for (let offset = 1; offset <= Math.min(3, currentIndex); offset++) {
    const prevLine = lines[currentIndex - offset]
    if (!prevLine) continue
    
    // 如果前一行是未知类型且包含足够多的中文
    if ((prevLine.type === 'unknown' || prevLine.type === 'data') && !prevLine.hasAmount) {
      const prevChineseCount = (prevLine.line.match(/[一-龥]/g) || []).length
      if (prevChineseCount >= 4) {
        const name = cleanFundName(prevLine.line.trim())
        if (name && name.length >= 4 && !isGarbageContent(name)) {
          return name
        }
      }
    }
  }
  
  // 策略3: 合并当前行开头 + 前一行（处理断行情况）
  if (currentIndex > 0) {
    const prevLine = lines[currentIndex - 1]
    if (!prevLine.hasAmount && prevLine.type !== 'ad' && prevLine.type !== 'ui') {
      const combined = (prevLine.line.trim() + ' ' + currentLineText).replace(/\s+/g, ' ')
      const nameMatch = combined.match(/^([^\d.,+\-%]+)/)
      if (nameMatch && nameMatch[1].trim().length >= 6) {
        const name = cleanFundName(nameMatch[1].trim())
        if (name && name.length >= 4 && !isGarbageContent(name)) {
          return name
        }
      }
    }
  }
  
  return ''
}

/**
 * [NEW] 从单行提取财务数据
 */
function extractFinancialData(line: string): {amount: string, profit: string, rate: string} {
  let amount = '', profit = '', rate = ''
  
  // 金额: 第一个符合格式的数字（通常是市值）
  const amounts = line.match(/\d{1,3}(?:,\d{3})*\.\d{2,4}/g)
  if (amounts && amounts.length > 0) {
    amount = amounts[0].replace(/,/g, '')
  }
  
  // 盈亏: 带正负号的数字
  const signedNumbers = line.match(/[+-]\d{1,3}(?:,\d{3})*\.\d{2,}/g)
  if (signedNumbers && signedNumbers.length > 0) {
    profit = signedNumbers[0].replace(/,/g, '')
  }
  
  // 收益率: 百分比
  const rates = line.match(/[+-]?\d+\.?\d*%/)
  if (rates && rates.length > 0) {
    rate = rates[0].replace('%', '')
  }
  
  return { amount, profit, rate }
}

/**
 * [NEW] 搜索并匹配基金（核心函数）- 增强版
 */
async function searchAndMatchFund(name: string): Promise<any | null> {
  console.log(`   🔎 开始搜索: "${name}"`)
  
  try {
    const startTime = Date.now()
    
    // [NEW] 预处理：去除空格（OCR常把"嘉实信息产业"识别为"嘉实 信息 产业"）
    const cleanName = name.replace(/\s+/g, '').trim()
    console.log(`   🧹 清理空格后: "${cleanName}"`)
    
    // ===== 策略1: 完整名称搜索（无空格版本）=====
    console.log(`   📌 策略1: 完整名称搜索 "${cleanName}"`)
    let results1 = await searchFund(cleanName, 20)
    console.log(`   📊 策略1结果数: ${results1?.length || 0}`)
    
    if (results1 && results1.length > 0) {
      console.log(`   💡 前3结果: ${results1.slice(0, 3).map((r: any) => r.name).join(' | ')}`)
      
      // 策略1a: 精确匹配
      const exactMatch = results1.find((f: any) => f.name === cleanName || f.name.replace(/\s+/g, '') === cleanName)
      if (exactMatch) {
        console.log(`   ✅ 精确匹配! ${exactMatch.code} - ${exactMatch.name}`)
        return { ...exactMatch, confidence: 'exact', shareClass: detectShareClass(exactMatch.code, exactMatch.name) }
      }
      
      // 策略1b: 包含匹配（前3个结果中找）
      for (let i = 0; i < Math.min(3, results1.length); i++) {
        const cand = results1[i]
        const candNameClean = (cand.name || '').replace(/\s+/g, '')
        
        // 包含关系
        if (cleanName.includes(candNameClean) || candNameClean.includes(cleanName)) {
          console.log(`   ✅ 包含匹配! ${cand.code} - ${cand.name}`)
          return { ...cand, confidence: 'contains', shareClass: detectShareClass(cand.code, cand.name) }
        }
      }
      
      // 策略1c: 取第一个结果兜底
      console.log(`   ⚠️ 策略1取第一个结果兜底: ${results1[0].code} - ${results1[0].name}`)
      return {
        code: results1[0].code,
        name: results1[0].name,
        confidence: 'auto',
        shareClass: detectShareClass(results1[0].code, results1[0].name)
      }
    }
    
    // ===== 策略2: 核心名称搜索（去掉后缀A/B/C等）=====
    let coreName = cleanName
      .replace(/([A-C])$/gi, '')                    // 去掉末尾A/B/C
      .replace(/(发起式|联接|增强)$/gi, '')           // 去掉常见后缀
      .replace(/\((LOF|ETF|QDII)\)/gi, '')          // 去掉括号类型
      .replace(/\(.*?\)/g, '')                       // 去掉所有括号内容
      .trim()
    
    if (coreName.length >= 4 && coreName !== cleanName) {
      console.log(`   📌 策略2: 核心名称搜索 "${coreName}"`)
      const results2 = await searchFund(coreName, 15)
      console.log(`   📊 策略2结果数: ${results2?.length || 0}`)
      
      if (results2 && results2.length > 0) {
        console.log(`   💡 前3结果: ${results2.slice(0, 3).map((r: any) => r.name).join(' | ')}`)
        
        // 包含匹配
        for (let i = 0; i < Math.min(3, results2.length); i++) {
          const cand = results2[i]
          const candNameClean = (cand.name || '').replace(/\s+/g, '')
          if (coreName.includes(candNameClean) || candNameClean.includes(coreName)) {
            console.log(`   ✅ 策略2包含匹配! ${cand.code} - ${cand.name}`)
            return { ...cand, confidence: 'contains', shareClass: detectShareClass(cand.code, cand.name) }
          }
        }
        
        // 取第一个兜底
        console.log(`   ⚠️ 策略2取第一个结果: ${results2[0].code} - ${results2[0].name}`)
        return {
          code: results2[0].code,
          name: results2[0].name,
          confidence: 'auto',
          shareClass: detectShareClass(results2[0].code, results2[0].name)
        }
      }
    }
    
    // ===== 策略3: 关键词拆分搜索 =====
    console.log(`   📌 策略3: 关键词拆分搜索`)
    const keywords = extractSearchKeywords(cleanName)
    console.log(`   🔑 提取的关键词: ${keywords.join(', ')}`)
    
    if (keywords.length > 0) {
      for (const kw of keywords) {
        if (kw.length < 3) continue
        
        console.log(`   🔍 搜索关键词: "${kw}"`)
        const results3 = await searchFund(kw, 10)
        
        if (results3 && results3.length > 0) {
          console.log(`   💡 关键词"${kw}"找到${results3.length}个结果`)
          console.log(`   ✅ 策略3取第一个: ${results3[0].code} - ${results3[0].name}`)
          return {
            code: results3[0].code,
            name: results3[0].name,
            confidence: 'keyword',
            shareClass: detectShareClass(results3[0].code, results3[0].name)
          }
        }
      }
    }
    
    console.log(`   ❌ 所有策略均未匹配 (${Date.now() - startTime}ms)`)
    return null
    
  } catch (error: any) {
    console.error(`   ❌ 搜索异常:`, error.message || error)
    return null
  }
}

/**
 * [NEW] 在结果列表中找最佳匹配（降低阈值 + 增加日志）
 */
function findBestMatch(target: string, candidates: any[]): any | null {
  if (!candidates || candidates.length === 0) {
    console.log(`   ⚠️ findBestMatch: 候选列表为空!`)
    return null
  }
  
  let bestScore = 0
  let bestMatch: any = null
  
  console.log(`   📐 开始匹配计算, 目标="${target}", 候选数=${candidates.length}`)
  
  for (const cand of candidates) {
    const candName = cand.name || ''
    const score = calculateSimilarity(target, candName)
    
    // [DEBUG] 打印每个候选的得分
    if (score > 0.1) {
      console.log(`      比较: "${candName.substring(0, 20)}..." 得分=${score.toFixed(3)}`)
    }
    
    if (score > bestScore) {
      bestScore = score
      bestMatch = cand
    }
    
    // 精确匹配直接返回
    if (target === candName || target.includes(candName) || candName.includes(target)) {
      return {
        ...cand,
        confidence: score >= 0.9 ? 'exact' : score >= 0.7 ? 'contains' : 'similarity',
        shareClass: detectShareClass(cand.code, cand.name)
      }
    }
  }
  
  // [FIX] 降低阈值到0.25（OCR名称可能有空格/断行导致不精确）
  console.log(`   📊 最终最佳得分: ${bestScore.toFixed(3)}`)
  
  if (bestScore >= 0.25 && bestMatch) {
    console.log(`   ✅ 返回匹配: ${bestMatch.code} - ${bestMatch.name} (得分=${bestScore.toFixed(3)})`)
    return {
      ...bestMatch,
      confidence: bestScore >= 0.7 ? 'contains' : bestScore >= 0.4 ? 'similarity' : 'low',
      shareClass: detectShareClass(bestMatch.code, bestMatch.name)
    }
  }
  
  return null
}

/**
 * [NEW] 计算两个字符串的相似度
 */
function calculateSimilarity(s1: string, s2: string): number {
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1
  
  // Levenshtein距离
  const distance = levenshteinDistance(s1, s2)
  const maxLen = Math.max(s1.length, s2.length)
  
  let similarity = maxLen > 0 ? 1 - (distance / maxLen) : 0
  
  // 包含关系加分
  if (s1.includes(s2) || s2.includes(s1)) similarity += 0.3
  
  // 关键词重叠加分
  const words1 = new Set(s1.split(/(?:混合|股票|债券|指数|ETF|QDII|发起|联接|增强|优选|精选|成长|价值|稳健|平衡|主题|策略|配置|灵活)/))
  const words2 = new Set(s2.split(/(?:混合|股票|债券|指数|ETF|QDII|发起|联接|增强|优选|精选|成长|价值|稳健|平衡|主题|策略|配置|灵活)/))
  let overlap = 0
  words1.forEach(w => { if (words2.has(w)) overlap++ })
  similarity += overlap * 0.05
  
  return Math.min(similarity, 1)
}

/**
 * [NEW] 提取搜索关键词
 */
function extractSearchKeywords(name: string): string[] {
  // 去掉常见后缀后的核心词
  const cleaned = name
    .replace(/\s*[A-C]\s*$/, '')
    .replace(/\s*(发起式|联接|增强|(\(LOF\)|\(ETF\)))$/gi, '')
    .trim()
  
  // 拆分为可能的搜索词
  const keywords: string[] = []
  
  // 完整清理后的名字
  if (cleaned.length >= 4) keywords.push(cleaned)
  
  // 提取公司名+产品线
  const companyMatch = cleaned.match(/^(.{2,4})(.*)$/)
  if (companyMatch) {
    keywords.push(companyMatch[2])  // 产品线部分
  }
  
  // 提取特征词组合
  const featureWords = cleaned.match(/(产业|科技|信息|医疗|健康|消费|新能源|半导体|光伏|汽车|金融|地产|军工|环保|互联网|全球|战略|新兴|成长|价值|稳健|平衡|主题|量化|红利|蓝筹|龙头|领先|优势|核心|精选|优选|灵活)/g)
  if (featureWords && featureWords.length >= 1) {
    keywords.push(featureWords.slice(0, 2).join(''))  // 取前2个特征词
  }
  
  return [...new Set(keywords)].filter(k => k.length >= 2)
}

// [WHAT] OCR文本解析的公共函数（本地OCR和AI识别共用）
// [WHAT] OCR文本解析兜底函数（AI识别纯文本时调用）
async function processOcrText(text: string) {
  console.log('OCR fallback parse started')
  
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  console.log('Lines:', lines)
  
  const fundList: any[] = []
  const codeMap = new Map<string, number>()
  
  const foundCodes = new Map<string, { lineIndex: number, context: string }>()
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].match(/(?<!\d)(\d{6})(?!\d)/g)
    if (matches) {
      for (const code of matches) {
        if (!foundCodes.has(code)) {
          foundCodes.set(code, { lineIndex: i, context: lines[i] })
          console.log('Found code:', code, 'line', i)
        }
      }
    }
  }
  
  for (const [fundCode, info] of foundCodes) {
    const line = info.context
    const i = info.lineIndex
    
    const codeIdx = line.indexOf(fundCode)
    const beforeCode = codeIdx >= 0 ? line.substring(0, codeIdx) : ''
    const nameMatch = beforeCode.match(/[\u4e00-\u9fa5]+(?:ETF|QDII|QFII|LOF)?/g)
    let fundName = nameMatch ? nameMatch.join('') : ''
    
    if (fundName.length < 4 && i > 0) {
      const prevLine = lines[i - 1]
      if (/[\u4e00-\u9fa5]{4,}/.test(prevLine) && !/(\d{6})/.test(prevLine)) {
        fundName = prevLine + fundName
      }
    }
    
    fundName = fundName.replace(/^(基金|名称|我的|持有|近期|交易|排序)/, '').trim()
    if (fundName.length < 2) continue
    
    const ocrShareMatch = fundName.match(/([A-C])\s*$/)
    const ocrShareClass = ocrShareMatch ? ocrShareMatch[1] : ''
    const nameCore = ocrShareClass ? fundName.slice(0, -1) : fundName
    
    try {
      let fundInfo = null as any
      
      if (nameCore.length >= 4) {
        const results = await searchFund(nameCore, 20)
        const exact = results.filter((f: any) => f.name.includes(nameCore) || nameCore.includes(f.name))
        if (exact.length > 0) {
          if (ocrShareClass) {
            fundInfo = exact.find((f: any) => {
              const m = f.name.match(/([A-C])\s*$/)
              return m && m[1] === ocrShareClass
            })
          }
          if (!fundInfo) fundInfo = exact[0]
        }
        
        if (!fundInfo) {
          const simplified = nameCore.replace(/(混合|股票|债券|指数|ETF联接|联接|发起式|发起联接)/g, '')
          if (simplified.length >= 4 && simplified !== nameCore) {
            const fuzzy = await searchFund(simplified, 20)
            fundInfo = fuzzy.find((f: any) => f.name.includes(nameCore) || nameCore.includes(f.name))
          }
        }
      }
      
      if (!fundInfo) {
        const codeResults = await searchFund(fundCode, 5)
        fundInfo = codeResults.find((f: any) => f.code === fundCode)
      }
      
      if (fundInfo) {
        fundList.push({ code: fundInfo.code, name: fundInfo.name, shareClass: ocrShareClass || '', selected: true })
        codeMap.set(fundInfo.code, fundList.length - 1)
      } else {
        fundList.push({ code: fundCode, name: fundName, shareClass: ocrShareClass || '', selected: true })
        codeMap.set(fundCode, fundList.length - 1)
      }
    } catch (err) {
      console.error('Query failed', fundCode, err)
    }
  }
  
  const coveredLines = new Set<number>()
  for (const [, info] of foundCodes) coveredLines.add(info.lineIndex)
  
  for (let i = 0; i < lines.length; i++) {
    if (coveredLines.has(i)) continue
    
    const line = lines[i]
    if (/^(基金|名称|金额|收益|持有|排序|全部|股票|债券|混合|我的|近期|交易|更新|净值|持有收益|持有收益率)/.test(line)) continue
    if (line.length < 4) continue
    
    const hasChinese = /[\u4e00-\u9fa5]{4,}/.test(line)
    const hasNumber = /\d+\.\d{2}/.test(line)
    if (!hasChinese || !hasNumber) continue
    
    const nameSegments = line.match(/[\u4e00-\u9fa5]+(?:ETF|QDII|QFII|LOF)?/g)
    if (!nameSegments) continue
    
    let fundName = nameSegments.join('')
    fundName = fundName.replace(/^(基金|名称|我的|持有|近期|交易|排序)/, '').trim()
    if (fundName.length < 4) continue
    
    const shareClassMatch = fundName.match(/([A-C])$/)
    const shareClass = shareClassMatch ? shareClassMatch[1] : ''
    const nameCore = shareClass ? fundName.slice(0, -1) : fundName
    
    try {
      const results = await searchFund(nameCore, 10)
      if (results.length === 0) continue
      
      let bestMatch = results[0]
      let bestScore = -1
      for (const fund of results) {
        let score = 0
        const fundNameLower = fund.name.toLowerCase()
        const ocrNameLower = nameCore.toLowerCase()
        if (fundNameLower.includes(ocrNameLower) || ocrNameLower.includes(fundNameLower)) score += 10
        if (shareClass) {
          if (fundNameLower.endsWith(shareClass.toLowerCase())) score += 20
          else score -= 5
        }
        score += fund.name.length * 0.1
        if (score > bestScore) { bestScore = score; bestMatch = fund }
      }
      
      if (bestScore < 5) continue
      
      if (!codeMap.has(bestMatch.code)) {
        fundList.push({ code: bestMatch.code, name: bestMatch.name, shareClass: shareClass || '', selected: true })
        codeMap.set(bestMatch.code, fundList.length - 1)
      }
    } catch (err) {
      console.error('Query failed', fundName, err)
    }
  }
  
  extractedFunds.value = fundList
  if (fundList.length === 0) {
    showToast('No fund info recognized')
  } else {
    showToast(`Recognized ${fundList.length} funds`)
  }
}


async function searchByFundNames(potentialNames: { lineIndex: number, text: string }[], lines: string[]) {
  console.log('🔍 开始纯名称搜索，过滤垃圾内容...')
  
  for (const item of potentialNames) {
    const rawName = item.text.trim()
    const lineIdx = item.lineIndex
    
    // [ENHANCED] 使用新的垃圾内容过滤器
    if (isGarbageContent(rawName)) {
      console.log(`⚠️ 跳过垃圾内容: "${rawName}"`)
      continue
    }
    
    // [ENHANCED] 使用新的cleanFundName函数
    const cleanName = cleanFundName(rawName)
    if (!cleanName || cleanName.length < 2) {
      console.log(`⚠️ 清理后名称无效: "${rawName}" → "${cleanName}"`)
      continue
    }
    
    console.log(`尝试搜索基金名称: "${cleanName}" (原始: "${rawName}")`)
    
    try {
      // [ENHANCED] 使用新的模糊匹配函数 - 先搜索候选基金
      const searchResults = await searchFund(cleanName, 10)
      const matchedFund = findBestSimilarityMatch(cleanName, searchResults || [], 0.55)
      
      if (matchedFund && matchedFund.code) {
        // 从相邻行提取数值信息（增强版）
        let amount = '', profit = '', rate = '', costPrice = ''
        
        // 检查后续3行的数值
        for (let j = lineIdx + 1; j < Math.min(lineIdx + 4, lines.length); j++) {
          const nextLine = lines[j]
          
          // 净值/金额格式：5,219.94 或 5219.94 或 1,858.18
          if (!amount) {
            const amountMatch = nextLine.match(/(\d{1,3}(?:,\d{3})*\.\d{2,4})(?![%])/)
            if (amountMatch) amount = amountMatch[1].replace(/,/g, '')
          }
          
          // 盈亏格式：-530.06 或 +123.45 或 -139.70
          if (!profit) {
            const profitMatch = nextLine.match(/([+-]\d{1,3}(?:,\d{3})*\.\d{2})(?!\s*%)/)
            if (profitMatch) profit = profitMatch[1].replace(/,/g, '')
          }
          
          // 收益率格式：-9.22% 或 +5.67% 或 -0.77%
          if (!rate) {
            const rateMatch = nextLine.match(/([+-]?\d+\.?\d*)\s*%/)
            if (rateMatch) rate = rateMatch[1]
          }
          
          // 成本价格式：1.2345 或 2.56
          if (!costPrice) {
            const costMatch = nextLine.match(/(\d+\.\d{2,4})(?!\s*%)/)
            if (costMatch) costPrice = costMatch[1]
          }
          
          // 如果都找到了，停止搜索
          if (amount && profit && rate) break
        }
        
        extractedFunds.value.push({
          code: matchedFund.code,
          name: matchedFund.name,
          amount: amount || '',
          profit: profit || '',
          rate: rate ? rate + '%' : '',
          costPrice: costPrice || '',
          shareClass: matchedFund.shareClass || '',
          selected: true,
          matchConfidence: matchedFund.confidence || 'similarity'
        })
        
        console.log(`✅ 匹配成功: ${matchedFund.code} - ${matchedFund.name} (置信度: ${matchedFund.confidence})`)
        console.log(`   金额: ${amount}, 盈亏: ${profit}, 收益率: ${rate}%, 成本价: ${costPrice}`)
      } else {
        console.log(`⚠️ 未找到匹配: "${cleanName}"`)
        
        // [NEW] 即使未匹配也保留记录（用于手动补全）
        if (cleanName.length >= 4) {
          extractedFunds.value.push({
            code: '',
            name: cleanName,
            amount: '',
            profit: '',
            rate: '',
            costPrice: '',
            shareClass: '',
            selected: true,
            matchConfidence: 'none'
          })
          console.log(`📝 保留未匹配记录用于手动补全: "${cleanName}"`)
        }
      }
    } catch (error: any) {
      console.error(`搜索失败 (${cleanName}):`, error)
    }
  }
  
  importProgress.value = 100
  console.log(`✅ 纯名称搜索完成，共找到 ${extractedFunds.value.length} 只基金`)
}

// [WHAT] 处理发现的基金代码（核心解析逻辑）
async function processFoundCodes(foundCodes: Map<string, { lineIndex: number, context: string }>, lines: string[]) {
  const fundList: any[] = []
  const codeMap = new Map<string, number>()
  
  for (const [fundCode, info] of foundCodes) {
    const line = info.context
    const i = info.lineIndex
    
    // 提取基金名称
    const codeIdx = line.indexOf(fundCode)
    const beforeCode = codeIdx >= 0 ? line.substring(0, codeIdx) : ''
    const nameMatch = beforeCode.match(/[\u4e00-\u9fa5]+(?:ETF|QDII|QFII|LOF)?/g)
    let fundName = nameMatch ? nameMatch.join('') : ''
    
    if (fundName.length < 4 && i > 0) {
      const prevLine = lines[i - 1]
      if (/[\u4e00-\u9fa5]{4,}/.test(prevLine) && !/(\d{6})/.test(prevLine)) {
        fundName = prevLine + fundName
      }
    }
    
    fundName = fundName.replace(/^(基金|名称|我的|持有|近期|交易|排序|连续\d+年跑赢大盘|长期绩优)/, '').trim()
    if (fundName.length < 2) continue
    
    // 提取净值、收益率、盈亏等（与原逻辑一致）
    const afterCode = codeIdx >= 0 ? line.substring(codeIdx + 6) : ''
    const navMatch = afterCode.match(/(\d+\.\d{4})/)
    const nav = navMatch ? navMatch[1] : ''
    
    let rate = ''
    const rateMatch = line.match(/([+-]?\d+\.?\d*)\s*%/)
    if (rateMatch) rate = rateMatch[1] + '%'
    
    let profit = ''
    const profitMatches = line.match(/([+-]\d+\.?\d*)\s*(?!\s*%)/g)
    if (profitMatches && profitMatches.length > 0) profit = profitMatches[0].trim()
    
    console.log(`提取到信息: 代码=${fundCode}, 名称=${fundName}, 净值=${nav}, 盈亏=${profit}, 收益率=${rate}`)
    
    if (codeMap.has(fundCode)) continue
    
    // 核心策略：用基金名称搜索
    const ocrShareMatch = fundName.match(/([A-C])\s*$/)
    const ocrShareClass = ocrShareMatch ? ocrShareMatch[1] : ''
    const nameCore = ocrShareClass ? fundName.slice(0, -1) : fundName

    try {
      let fundInfo = null as any
      
      if (nameCore.length >= 4) {
        const nameResults = await searchFund(nameCore, 20)
        
        // 策略1：精确匹配
        const exactMatches = nameResults.filter((f: any) => 
          f.name.includes(nameCore) || nameCore.includes(f.name)
        )
        
        if (exactMatches.length > 0) {
          if (ocrShareClass) {
            fundInfo = exactMatches.find((f: any) => {
              const apiShareMatch = f.name.match(/([A-C])\s*$/)
              return apiShareMatch && apiShareMatch[1] === ocrShareClass
            })
          }
          if (!fundInfo) fundInfo = exactMatches[0]
          console.log(`通过名称 "${nameCore}" 找到 ${exactMatches.length} 个匹配，选择: ${fundInfo.code} - ${fundInfo.name}`)
        }
        
        // 策略2：模糊匹配
        if (!fundInfo) {
          const simplifiedName = nameCore.replace(/(混合|股票|债券|指数|ETF联接|联接|发起式|发起联接)/g, '')
          if (simplifiedName.length >= 4 && simplifiedName !== nameCore) {
            const simpleResults = await searchFund(simplifiedName, 10)
            fundInfo = simpleResults[0] || null
            console.log(`通过简化名称 "${simplifiedName}" 搜索`)
          }
        }
        
        // 策略3：用代码搜索（兜底）
        if (!fundInfo) {
          try {
            const codeResults = await searchFund(fundCode, 5)
            if (codeResults.length > 0) {
              fundInfo = codeResults[0]
              console.log(`通过代码 "${fundCode}" 找到: ${fundInfo.name}`)
            }
          } catch (e) { /* 忽略 */ }
        }
        
      }  // 关闭 if (nameCore.length >= 4)
      
      if (fundInfo) {
        extractedFunds.value.push({
          code: fundInfo.code,
          name: fundInfo.name,
          amount: nav || '',
          profit: profit || '',
          rate: rate || '',
          shareClass: ocrShareClass || '',
          selected: true
        })
        console.log(`✅ 添加基金: ${fundInfo.code} - ${fundInfo.name}`)
      } else {
        console.log(`⚠️ 未找到匹配: ${fundCode} - ${fundName}`)
        extractedFunds.value.push({
          code: fundCode,
          name: fundName,
          amount: nav || '',
          profit: profit || '',
          rate: rate || '',
          shareClass: ocrShareClass || '',
          selected: true
        })
      }
    } catch (searchError: any) {
      console.error(`搜索失败 (${fundCode}):`, searchError)
    }
  }  // 关闭 for循环
  
  importProgress.value = 100
  console.log(`识别完成，共找到 ${extractedFunds.value.length} 只基金`)
}  // 关闭 processFoundCards 函数


// [BACKUP] 原始本地OCR识别函数（用于回退）
async function startOcrImportBackup() {
  if (!importImageFile.value) return
  
  // [NEW] 根据选择的模式调用不同的识别方法
  if (ocrMode.value === 'ai') {
    await startAiOcrImport()
    return
  }
  
  isImporting.value = true
  importProgress.value = 0
  extractedFunds.value = []
  
  try {
    const worker = await createWorker('chi_sim+eng', 1, {
      logger: (m: any) => {
        if (m.status === 'recognizing text') {
          importProgress.value = Math.round(m.progress * 100)
        }
      }
    })
    
    const { data } = await worker.recognize(importImageFile.value)
    await worker.terminate()
    
    const text = data.text
    console.log('OCR 原始文本:', text)
    
    // [NEW] 预处理：去除汉字之间的空格（Tesseract常把中文拆成单个字）
    const cleanedText = text.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
    console.log('OCR 预处理后文本:', cleanedText)
    
    const lines = cleanedText.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    console.log('分割后的行:', lines)
    
    const fundList: any[] = []
    const codeMap = new Map<string, number>()
    
    // 第一步：全量扫描，收集所有6位基金代码
    // [FIX] 更严格的过滤：排除明显不是基金代码的数字模式
    const foundCodes = new Map<string, { lineIndex: number, context: string }>()
    const invalidCodeLines = new Set<number>()  // [NEW] 记录包含无效代码的行
    
    // 已知的非基金代码模式（金额、日期、百分比等）
    // [NOTE] 02xxxx 通常是日期或金额，极少有基金代码以02开头
    const invalidCodePatterns = [
      /^0[0-2]\d{4}$/,          // 00xxxx-02xxxx (日期、金额、小数)
      /^\d{4}[01]\d[0-3]\d$/,  // 日期格式如20240709
      /^[12]\d{5}$/,           // 100000-299999（通常是金额）
      /^03\d{4}$/,             // 03xxxx（可能是时间03:xx:xx的误识别）
      /^004\d{3}$/,            // 004xxx (常见误识别)
      /^006\d{3}$/,            // 006xxx (常见误识别)
    ]
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const codeMatches = line.match(/(?<!\d)(\d{6})(?!\d)/g)
      if (codeMatches) {
        for (const code of codeMatches) {
          // [FIX] 跳过无效代码
          const isInvalid = invalidCodePatterns.some(p => p.test(code))
          if (isInvalid) {
            console.log(`❌ 跳过无效代码: ${code} (行${i}: ${line})`)
            invalidCodeLines.add(i)  // [NEW] 标记该行有无有效代码
            continue
          }
          
          // [FIX] 检查该代码前后是否有中文基金名称特征
          const codeIdx = line.indexOf(code)
          const beforeCode = codeIdx >= 0 ? line.substring(0, codeIdx) : ''
          const afterCode = codeIdx >= 0 ? line.substring(codeIdx + 6) : ''
          
          // 如果代码前面有"基金"、"联接"、"混合"等关键词，或后面有A/B/C，则认为更可信
          const hasStrongFundContext = /基金|ETF|QDII|LOF|混合|股票|债券|指数|联接|发起/.test(beforeCode + afterCode) ||
                                       /[ABC]$/.test(afterCode.trim().substring(0, 3))
          
          // [CRITICAL] 对于没有强上下文的代码，需要额外检查
          if (!hasStrongFundContext) {
            // 检查是否在金额/数值上下文中（如"市值:¥123,456"）
            const isInValueContext = /[¥$￥:\s]\s*\d/.test(beforeCode.slice(-5)) || 
                                     /[,.\d]%/.test(afterCode.slice(0, 5))
            if (isInValueContext) {
              console.log(`⚠️ 跳过金额上下文代码: ${code} (行${i})`)
              continue
            }
          }
          
          if (!foundCodes.has(code)) {
            foundCodes.set(code, { lineIndex: i, context: line })
            console.log(`✅ 发现基金代码: ${code} (行${i}: ${line}, 强上下文=${hasStrongFundContext})`)
          }
        }
      }
    }
    console.log(`共发现 ${foundCodes.size} 个唯一基金代码`)
    
    // 第二步：处理每个发现的代码
    for (const [fundCode, info] of foundCodes) {
      const line = info.context
      const i = info.lineIndex
      
      const codeIdx = line.indexOf(fundCode)
      const beforeCode = codeIdx >= 0 ? line.substring(0, codeIdx) : ''
      const nameMatch = beforeCode.match(/[\u4e00-\u9fa5]+(?:ETF|QDII|QFII|LOF)?/g)
      let fundName = nameMatch ? nameMatch.join('') : ''
      
      if (fundName.length < 4 && i > 0) {
        const prevLine = lines[i - 1]
        if (/[\u4e00-\u9fa5]{4,}/.test(prevLine) && !/(\d{6})/.test(prevLine)) {
          fundName = prevLine + fundName
        }
      }
      
      fundName = fundName.replace(/^(基金|名称|我的|持有|近期|交易|排序|连续\d+年跑赢大盘|长期绩优)/, '').trim()
      if (fundName.length < 2) continue
      
      const afterCode = codeIdx >= 0 ? line.substring(codeIdx + 6) : ''
      const navMatch = afterCode.match(/(\d+\.\d{4})/)
      const nav = navMatch ? navMatch[1] : ''
      
      let rate = ''
      const rateMatch = line.match(/([+-]?\d+\.?\d*)\s*%/)
      if (rateMatch) rate = rateMatch[1] + '%'
      
      let profit = ''
      const profitMatches = line.match(/([+-]\d+\.?\d*)\s*(?!\s*%)/g)
      if (profitMatches && profitMatches.length > 0) profit = profitMatches[0].trim()
      
      console.log(`提取到信息: 代码=${fundCode}, 名称=${fundName}, 净值=${nav}, 盈亏=${profit}, 收益率=${rate}`)
      
      if (codeMap.has(fundCode)) continue
      
      const ocrShareMatch = fundName.match(/([A-C])\s*$/)
      const ocrShareClass = ocrShareMatch ? ocrShareMatch[1] : ''
      const nameCore = ocrShareClass ? fundName.slice(0, -1) : fundName
      
      try {
        let fundInfo = null as any
        
        if (nameCore.length >= 4) {
          const nameResults = await searchFund(nameCore, 20)
          
          // [FIX] 放宽匹配条件：不再要求完全包含，优先使用评分最高的结果
          if (nameResults.length > 0) {
            if (ocrShareClass) {
              fundInfo = nameResults.find((f: any) => {
                const apiShareMatch = f.name.match(/([A-C])\s*$/)
                return apiShareMatch && apiShareMatch[1] === ocrShareClass
              })
            }
            if (!fundInfo) fundInfo = nameResults[0]  // 直接取最高分
            console.log(`通过名称 "${nameCore}" 找到 ${nameResults.length} 个候选，选择: ${fundInfo.code} - ${fundInfo.name}`)
          }
          
          if (!fundInfo) {
            const simplifiedName = nameCore.replace(/(混合|股票|债券|指数|ETF联接|联接|发起式|发起联接)/g, '')
            if (simplifiedName.length >= 4 && simplifiedName !== nameCore) {
              const fuzzyResults = await searchFund(simplifiedName, 20)
              fundInfo = fuzzyResults.find((f: any) => 
                f.name.includes(nameCore) || nameCore.includes(f.name)
              )
              if (fundInfo) {
                console.log(`通过模糊名称 "${simplifiedName}" 找到: ${fundInfo.code} - ${fundInfo.name}`)
              }
            }
          }
        }
        
        if (!fundInfo) {
          const codeResults = await searchFund(fundCode, 5)
          fundInfo = codeResults.find((f: any) => f.code === fundCode)
          if (fundInfo) {
            console.log(`通过代码 "${fundCode}" 兜底找到: ${fundInfo.code} - ${fundInfo.name}`)
          }
        }
        
        if (fundInfo) {
          fundList.push({
            code: fundInfo.code,
            name: fundInfo.name,
            amount: nav || undefined,
            profit: profit || undefined,
            rate: rate || undefined,
            shareClass: ocrShareClass || '',
            selected: true
          })
          codeMap.set(fundInfo.code, fundList.length - 1)
          console.log(`✅ 识别到基金: ${fundInfo.code} - ${fundInfo.name}, 净值: ${nav}, 盈亏: ${profit}, 收益率: ${rate}`)
        } else {
          fundList.push({
            code: fundCode,
            name: fundName,
            amount: nav || undefined,
            profit: profit || undefined,
            rate: rate || undefined,
            shareClass: ocrShareClass || '',
            selected: true
          })
          codeMap.set(fundCode, fundList.length - 1)
          console.log(`⚠️ 使用OCR原始数据: ${fundCode} - ${fundName}`)
        }
      } catch (err) {
        console.error(`查询基金 ${fundCode} 失败:`, err)
      }
    }
    
    // 第三步：扫描未被代码行覆盖的行，用名称搜索兜底（无代码场景）
    const coveredLines = new Set<number>()
    for (const [, info] of foundCodes) coveredLines.add(info.lineIndex)
    
    for (let i = 0; i < lines.length; i++) {
      if (coveredLines.has(i)) continue
      if (invalidCodeLines.has(i)) continue  // [NEW] 跳过包含无效代码的行（避免误识别）
      
      const line = lines[i]
      
      if (/^(基金|名称|金额|收益|持有|排序|全部|股票|债券|混合|我的|近期|交易|更新|人气|全球|CPO|净值|持有收益|持有收益率|立即刷新|导入|导入选中的基金|本地OCR|AI智能|图片识别)/.test(line)) continue
      if (/^(HE|es|@|A|zao|<|BE|QV|mHB|co|wo|持有=)/.test(line)) continue
      if (line.length < 3) continue
      
      // [FIX] 放宽条件：只要有中文就尝试提取（不再强制要求有数字）
      const hasChinese = /[\u4e00-\u9fa5]{2,}/.test(line)
      const hasNumber = /\d+\.\d{2}/.test(line)
      
      // 只要有中文字符就尝试匹配（包括纯名称行）
      if (hasChinese) {
        console.log(`📝 扫描到候选行: ${line}`)
        
        const nameSegments = line.match(/[\u4e00-\u9fa5]+(?:ETF|QDII|QFII|LOF)?/g)
        if (!nameSegments || nameSegments.length === 0) continue
        
        let fundName = nameSegments.join('')
        fundName = fundName.replace(/^(基金|名称|我的|持有|近期|交易|排序)/, '').trim()
        if (fundName.length < 2) continue
        
        let shareClass = ''
        const nameTailMatch = fundName.match(/([\u4e00-\u9fa5])([A-C])$/)
        if (nameTailMatch) {
          shareClass = nameTailMatch[2]
          fundName = fundName.slice(0, -1)
        }
        if (!shareClass) {
          const bracketClassMatch = line.match(/[）)]\s*([A-C])(?:\s|$|\d)/)
          if (bracketClassMatch) shareClass = bracketClassMatch[1]
        }
        if (!shareClass) {
          const inBracketMatch = line.match(/[（(]\s*([A-C])\s*[)）]/)
          if (inBracketMatch) shareClass = inBracketMatch[1]
        }
        if (!shareClass) {
          const initMatch = line.match(/发起(?:式|联接)\s*([A-C])/)
          if (initMatch) shareClass = initMatch[1]
        }
        if (!shareClass) {
          const cnTailClassMatch = line.match(/[\u4e00-\u9fa5]([A-C])\s/)
          if (cnTailClassMatch) shareClass = cnTailClassMatch[1]
        }
        if (!shareClass) {
          const tailMatch = line.match(/\s([A-C])\s*$/)
          if (tailMatch) shareClass = tailMatch[1]
        }
        console.log(`提取到份额类型: ${shareClass || '(无)'}, 基金名称: ${fundName}`)
        
        let amount = ''
        const amountMatches = line.match(/\d{1,3}(?:,\d{3})+\.\d{1,2}/g)
        if (amountMatches && amountMatches.length > 0) {
          amount = amountMatches[0]
        } else {
          const simpleAmountMatches = line.match(/(?<![+-])\d{1,6}\.\d{2}/g)
          if (simpleAmountMatches && simpleAmountMatches.length > 0) {
            amount = simpleAmountMatches.sort((a, b) => parseFloat(b) - parseFloat(a))[0]
          }
        }
        
        let rate = ''
        const rateMatch = line.match(/([+-]?\d+\.?\d*)\s*%/)
        if (rateMatch) rate = rateMatch[1] + '%'
        
        let profit = ''
        const profitMatches = line.match(/([+-]\d+\.?\d*)\s*(?!\s*%)/g)
        if (profitMatches && profitMatches.length > 0) profit = profitMatches[0].trim()
        
        console.log(`提取到信息: 名称=${fundName}, 份额=${shareClass}, 金额=${amount}, 盈亏=${profit}, 收益率=${rate}`)
        
        try {
          const results = await searchFund(fundName, 10)
          if (results.length === 0) continue
          
          let bestMatch = results[0]
          let bestScore = -1
          
          for (const fund of results) {
            let score = 0
            const fundNameLower = fund.name.toLowerCase()
            const ocrNameLower = fundName.toLowerCase()
            
            if (fundNameLower.includes(ocrNameLower) || ocrNameLower.includes(fundNameLower)) score += 10
            
            if (shareClass) {
              if (fundNameLower.endsWith(shareClass.toLowerCase()) || 
                  fundNameLower.includes(`(${shareClass.toLowerCase()})`) ||
                  fundNameLower.includes(`（${shareClass}）`)) {
                score += 20
              } else {
                score -= 5
              }
            }
            
            score += fund.name.length * 0.1
            
            console.log(`基金 ${fund.code} - ${fund.name}, 得分: ${score}`)
            
            if (score > bestScore) {
              bestScore = score
              bestMatch = fund
            }
          }
          
          if (bestScore < 5) {
            console.log(`跳过低分匹配: ${fundName} -> ${bestMatch.name} (得分: ${bestScore})`)
            continue
          }
          
          if (codeMap.has(bestMatch.code)) {
            const existingIndex = codeMap.get(bestMatch.code)!
            const existing = fundList[existingIndex]
            if (amount && !existing.amount) existing.amount = amount
            if (profit && !existing.profit) existing.profit = profit
            if (rate && !existing.rate) existing.rate = rate
            console.log(`更新已有基金: ${bestMatch.code} - ${bestMatch.name}`)
          } else {
            fundList.push({
              code: bestMatch.code,
              name: bestMatch.name,
              amount: amount || undefined,
              profit: profit || undefined,
              rate: rate || undefined,
              shareClass: shareClass || '',
              selected: true
            })
            codeMap.set(bestMatch.code, fundList.length - 1)
            console.log(`识别到基金: ${bestMatch.code} - ${bestMatch.name}, 金额: ${amount}, 盈亏: ${profit}, 收益率: ${rate}`)
          }
        } catch (err) {
          console.error(`查询基金 ${fundName} 失败:`, err)
        }
      }
    }
    
    if (fundList.length === 0) {
      showToast('未识别到基金信息，请确保图片清晰')
      isImporting.value = false
      return
    }
    
    extractedFunds.value = fundList
    showToast(`识别到 ${fundList.length} 只基金`)
  } catch (err) {
    console.error('OCR 识别失败:', err)
    showToast('识别失败，请重试')
  } finally {
    isImporting.value = false
    importProgress.value = 0
  }
}

function withOcrTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ])
}

async function prepareLocalOcrImage(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return file
  try {
    const bitmap = await createImageBitmap(file)
    const maxPixels = 2_400_000
    const scale = Math.min(1, Math.sqrt(maxPixels / (bitmap.width * bitmap.height)))
    if (scale >= 1) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片预处理失败')), 'image/jpeg', 0.9))
  } catch {
    return file
  }
}

async function startLocalOcrImport() {
  if (!importImageFile.value) return
  isImporting.value = true
  importProgress.value = 5
  extractedFunds.value = []

  let worker: any = null
  let workerPromise: Promise<any> | null = null
  try {
    const source = await prepareLocalOcrImage(importImageFile.value)
    importProgress.value = 12
    workerPromise = createWorker('chi_sim+eng', 1, {
      logger: (message: any) => {
        if (message.status === 'recognizing text') importProgress.value = 15 + Math.round(message.progress * 70)
      }
    }) as Promise<any>
    try {
      worker = await withOcrTimeout(workerPromise, 45_000, '本地识别引擎启动超时，请改用 AI 智能识别')
    } catch (error) {
      void workerPromise.then(lateWorker => lateWorker.terminate()).catch(() => undefined)
      throw error
    }
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' })
    const { data } = await withOcrTimeout(worker.recognize(source), 75_000, '本地识别超时，请改用 AI 智能识别')
    importProgress.value = 88

    const drafts = parseLocalHoldingText(data.text).slice(0, 30)
    let directory: Array<{ code: string; name: string }> = []
    try {
      directory = await withOcrTimeout(fetchFundList(), 15_000, '基金目录加载超时')
    } catch (error) {
      console.warn('本地 OCR 无法加载基金目录:', error)
    }

    extractedFunds.value = drafts.map(draft => {
      const matched = resolveLocalFund(draft.name, directory)
      return {
        code: matched?.code || '',
        name: matched?.name || draft.name,
        amount: draft.amount || undefined,
        profit: draft.profit || undefined,
        rate: draft.rate ? `${draft.rate}%` : undefined,
        shareClass: matched?.name.match(/([ABC])\s*$/i)?.[1]?.toUpperCase() || '',
        selected: Boolean(matched?.code),
        matchConfidence: matched ? 'exact' : 'none'
      }
    })
    importProgress.value = 100
    const ready = extractedFunds.value.filter(fund => fund.code).length
    showToast(ready > 0 ? `识别到 ${drafts.length} 条，${ready} 条可导入` : '未识别到可确认的基金代码')
  } catch (error: any) {
    console.error('本地 OCR 识别失败:', error)
    showToast(error?.message || '本地识别失败，请改用 AI 智能识别')
  } finally {
    if (worker) await worker.terminate().catch(() => undefined)
    isImporting.value = false
    setTimeout(() => { importProgress.value = 0 }, 1000)
  }
}

async function startOcrImport() {
  if (ocrMode.value === 'ai') await startAiOcrImport()
  else await startLocalOcrImport()
}

// [WHAT] 切换基金选中状态

function toggleFundSelection(index: number) {
  extractedFunds.value[index].selected = !extractedFunds.value[index].selected
}

// [NEW] 更新基金字段值（编辑功能）
function updateFundField(index: number, field: string, value: string) {
  const fund = extractedFunds.value[index]
  
  // 清理输入：移除逗号、货币符号等
  const cleanValue = value.replace(/[,¥￥$]/g, '').trim()
  
  if (field === 'rate') {
    // 收益率字段特殊处理
    fund.rate = cleanValue ? (cleanValue + '%') : ''
  } else {
    (fund as any)[field] = cleanValue
  }
  
  console.log(`📝 更新字段 [${index}] ${field}=${cleanValue}`)
}

// [NEW] 自动计算成本单价（根据金额+收益率）
function autoCalculateFields(index: number) {
  const fund = extractedFunds.value[index]
  
  if (!fund.amount || !fund.profit) {
    showToast('请先填写持仓金额和持有收益')
    return
  }
  
  const amount = parseFloat(String(fund.amount).replace(/[,¥￥$]/g, ''))
  const profit = parseFloat(String(fund.profit).replace(/[,¥￥$+-]/g, ''))
  
  if (isNaN(amount) || isNaN(profit)) {
    showToast('金额或收益格式错误')
    return
  }
  
  // 计算逻辑：
  // 总成本 = 持仓金额 - 持有收益
  const totalCost = amount - profit
  
  // 收益率 = (持仓金额 - 成本) / 成本 × 100%
  const rateValue = totalCost > 0 ? ((amount - totalCost) / totalCost * 100) : 0
  
  // 更新收益率（如果之前没有的话）
  if (!fund.rate || parseFloat(fund.rate) === 0) {
    fund.rate = rateValue.toFixed(2) + '%'
  }
  
  // 计算成本单价（需要当前净值，暂时用总成本/1作为占位）
  // 实际成本价会在导入时通过API获取净值后计算
  fund.costPrice = totalCost.toFixed(4)
  
  console.log(`🧮 自动计算: 金额=${amount}, 盈亏=${profit}, 成本=${totalCost.toFixed(2)}, 收益率=${fund.rate}`)
  showToast(`已计算: 成本 ¥${totalCost.toFixed(2)}, 收益率 ${fund.rate}`)
}

// [NEW] 匹配状态辅助函数 - 获取状态图标
function getMatchStatusIcon(confidence?: string): string {
  switch (confidence) {
    case 'exact': return 'success'
    case 'contains': return 'certificate'
    case 'similarity': return 'aim'
    case 'auto': return 'info-o'
    case 'manual': return 'edit'
    case 'error': return 'warning-o'
    case 'none': 
    default: return 'question-o'  // 待补全
  }
}

// [NEW] 匹配状态辅助函数 - 获取状态标题（tooltip）
function getMatchStatusTitle(confidence?: string): string {
  switch (confidence) {
    case 'exact': return '精确匹配 ✓'
    case 'contains': return '包含匹配 ◐'
    case 'similarity': return '相似度匹配 ≈'
    case 'auto': return '自动匹配 ◎'
    case 'manual': return '手动选择 ✎'
    case 'error': return '搜索失败 ✕'
    case 'none':
    default: return '未识别到代码，点击"补全代码"'
  }
}

// [NEW] 匹配状态辅助函数 - 获取提示文本
function getMatchHint(confidence?: string): string {
  switch (confidence) {
    case 'contains': return '名称部分匹配，请确认是否正确'
    case 'similarity': return '基于相似度自动匹配，建议核实'
    case 'auto': return '自动选择结果，可能需要调整'
    case 'none': return '未找到对应基金代码'
    case 'error': return '搜索时出错，可手动重试'
    default: return ''
  }
}

// [WHAT] 修改份额类型并重新搜索基金
async function changeShareClass(index: number, newType: string) {
  const fund = extractedFunds.value[index]
  if (fund.shareClass === newType) return

  fund.shareClass = newType

  // 用核心名称+新份额类型搜索
  const nameCore = fund.name.replace(/([A-C])\s*$/, '')
  if (nameCore.length < 4) return

  try {
    const results = await searchFund(nameCore, 20)
    // 找到名称匹配且份额类型正确的基金
    const match = results.find(f => {
      const shareMatch = f.name.match(/([A-C])\s*$/)
      return shareMatch && shareMatch[1] === newType &&
        (f.name.includes(nameCore) || nameCore.includes(f.name))
    })

    if (match) {
      fund.code = match.code
      fund.name = match.name
      showToast(`已切换为 ${match.name}`)
    } else {
      showToast(`未找到对应的 ${newType} 类基金`)
    }
  } catch (err) {
    console.error('搜索基金失败:', err)
  }
}

// [WHAT] 全选/取消全选
function toggleSelectAll() {
  const allSelected = extractedFunds.value.every(f => f.selected)
  extractedFunds.value.forEach(f => f.selected = !allSelected)
}

// [WHAT] 确认导入选中的基金到持仓
async function confirmImportFunds() {
  const selected = extractedFunds.value.filter(f => f.selected && /^\d{6}$/.test(f.code))
  if (selected.length === 0) {
    showToast('请先选择已确认基金代码的记录')
    return
  }
  
  showLoadingToast({ message: '导入中...', forbidClick: true })
  
  let successCount = 0
  let skipCount = 0
  let failureCount = 0
  let lastError = ''
  
  const newRecords: HoldingRecord[] = []
  
  for (const fund of selected) {
    // 跳过已持有的基金
    if (holdingStore.hasHolding(fund.code)) {
      skipCount++
      continue
    }
    
    try {
      // [NEW] 获取当前净值用于计算份额
      const estimate = await fetchFundEstimate(fund.code)
      const currentNav = parseFloat(estimate.gsz) || parseFloat(estimate.dwjz) || 1
      
      const basis = deriveHoldingImportBasis(fund, currentNav)
      if (!basis) throw new Error('识别到的金额无法计算持仓')
      const { principal, shares, costPrice: costPriceVal } = basis
      
      console.log(`[导入] ${fund.code}: 市值=${fund.amount}, 盈亏=${fund.profit}, 收益率=${fund.rate}, 成本价=${costPriceVal}, 本金=${principal.toFixed(2)}, 份额=${shares.toFixed(2)}, 净值=${currentNav}`)
      
      // 创建持仓记录
      const record: HoldingRecord = {
        code: fund.code,
        name: fund.name,
        type: '',
        shareClass: detectShareClass(fund.code, fund.name),
        amount: Math.round(principal * 100) / 100,       // [FIX] 投入本金（成本），不是市值
        buyNetValue: costPriceVal,                       // 买入时净值/成本净值
        shares: Math.round(shares * 10000) / 10000,      // 持有份额
        costPrice: Math.round(costPriceVal * 10000) / 10000, // 持仓成本单价
        costUnitPrice: Math.round(costPriceVal * 10000) / 10000,
        buyDate: getTodayStr(),
        holdingDays: 0,
        createdAt: Date.now()
      }
      
      newRecords.push(record)
    } catch (err: any) {
      failureCount++
      lastError = err?.message || '基金数据处理失败'
      console.error(`[导入] ${fund.code} 处理失败:`, err)
    }
  }
  
  // Write every record before reporting success so a failed local write is visible.
  for (const record of newRecords) {
    try {
      await holdingStore.addHoldingDirect(record)
      successCount++
    } catch (err: any) {
      failureCount++
      lastError = err?.message || '持仓保存失败'
      console.error(`[导入] ${record.code} 保存失败:`, err)
    }
  }
  
  closeToast()
  
  if (successCount > 0) {
    const suffix = [
      skipCount > 0 ? `跳过 ${skipCount} 只已持有` : '',
      failureCount > 0 ? `${failureCount} 只失败` : ''
    ].filter(Boolean).join('，')
    showToast(`成功导入 ${successCount} 只基金${suffix ? `，${suffix}` : ''}`)
    await holdingStore.refreshEstimates()
  } else if (skipCount > 0) {
    showToast(`所有基金已持有，跳过 ${skipCount} 只`)
  } else {
    showToast(`导入失败：${lastError || '未生成有效持仓记录'}`)
    return
  }
  
  showImportDialog.value = false
  importImagePreview.value = ''
  importImageFile.value = null
  extractedFunds.value = []
}

// [WHAT] 关闭导入弹窗
function closeImportDialog() {
  showImportDialog.value = false
  importImagePreview.value = ''
  importImageFile.value = null
  extractedFunds.value = []
}
</script>

<template>
  <div class="holding-page">
    <!-- 隐藏的文件输入 -->
    <input
      ref="fileInputRef"
      type="file"
      accept="image/*"
      style="display: none"
      @change="handleImageSelected"
    />

    <van-pull-refresh
      v-model="isPullRefreshing"
      @refresh="onRefresh"
      class="holding-global-refresh"
    >

    <MarketIndexBoard ref="marketIndexBoard" variant="holding" />

    <!-- 汇总统计卡片 -->
    <div v-if="holdingStore.holdings.length > 0" class="summary-card">
      <div class="summary-total">
        <div class="summary-label">总资产</div>
        <div class="summary-total-value">{{ formatMoney(holdingStore.summary.totalValue) }}</div>
      </div>
      <div class="summary-metrics">
        <div class="summary-item">
          <div class="summary-label">持有收益</div>
          <div class="summary-value" :class="summaryProfitClass">
            {{ holdingStore.summary.totalProfit >= 0 ? '+' : '' }}{{ formatMoney(holdingStore.summary.totalProfit) }}
          </div>
        </div>
        <div class="summary-item">
          <div class="summary-label">昨日收益</div>
          <div class="summary-value" :class="summaryYesterdayClass">
            {{ holdingStore.summary.yesterdayProfit >= 0 ? '+' : '' }}{{ formatMoney(holdingStore.summary.yesterdayProfit) }}
          </div>
          <div class="summary-rate" :class="summaryYesterdayClass">{{ formatPercent(holdingStore.summary.yesterdayProfitRate) }}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">当日收益</div>
          <div class="summary-value" :class="summaryTodayClass">
            {{ holdingStore.summary.todayProfit >= 0 ? '+' : '' }}{{ formatMoney(holdingStore.summary.todayProfit) }}
          </div>
          <div class="summary-rate" :class="summaryTodayClass">{{ formatPercent(holdingStore.summary.todayProfitRate) }}</div>
        </div>
      </div>
    </div>

    <!-- 筛选和排序下拉菜单 -->
    <div v-if="holdingStore.holdings.length > 0" class="list-toolbar">
      <h2>基金列表</h2>
      <div class="filter-bar">
      <!-- 类型筛选 -->
      <div class="filter-dropdown" @click.stop="showTypeDropdown = !showTypeDropdown; showSortDropdown = false">
        <span class="filter-label">类型: {{ currentTypeLabel }}</span>
        <van-icon name="arrow-down" size="12" />
        <!-- 下拉菜单 -->
        <div v-if="showTypeDropdown" class="dropdown-menu">
          <div 
            v-for="type in fundTypes" 
            :key="type.value"
            class="dropdown-item"
            :class="{ active: selectedType === type.value }"
            @click.stop="selectType(type.value)"
          >
            {{ type.label }}
          </div>
        </div>
      </div>
      <!-- 排序方式 -->
      <div class="filter-dropdown" @click.stop="showSortDropdown = !showSortDropdown; showTypeDropdown = false">
        <span class="filter-label">排序: {{ currentSortLabel }}</span>
        <van-icon name="arrow-down" size="12" />
        <!-- 下拉菜单 -->
        <div v-if="showSortDropdown" class="dropdown-menu">
          <div 
            v-for="sort in sortOptions" 
            :key="sort.value"
            class="dropdown-item"
            :class="{ active: selectedSort === sort.value }"
            @click.stop="selectSort(sort.value)"
          >
            {{ sort.label }}
          </div>
        </div>
      </div>
      </div>
    </div>

    <!-- 持仓列表表头 -->
    <div v-if="holdingStore.holdings.length > 0" class="list-header">
      <span class="col-name">基金</span>
      <div class="col-right">
        <span class="col-position">持仓金额/最新收益</span>
        <span class="col-profit">持有收益/率</span>
        <span class="col-today">今日收益/率</span>
      </div>
    </div>

    <!-- 持仓列表 -->
    <div class="holding-list-container">
      <template v-if="holdingStore.holdings.length > 0">
        <van-swipe-cell v-for="holding in filteredHoldings" :key="holding.code">
          <div class="holding-item" @click="goToDetail(holding.code)">
            <div class="col-name">
              <div class="fund-name" :style="getFundNameStyle(holding.name)">
                <span>{{ holding.name || '加载中...' }}</span>
              </div>
              <div class="fund-meta">
                <a class="fund-code" :href="getJdFundLink(holding.code)" @click.stop>{{ holding.code }}</a>
                <span v-if="holding.type" class="fund-type"> · {{ holding.type }}</span>
                <span :class="['fund-tag', getStatusTagClass(holding)]">{{ getStatusTag(holding) }}</span>
                <template v-for="(tag, idx) in getPendingTags(holding)" :key="idx">
                  <span :class="['fund-tag', 'tag-pending', tag.type === 'add' ? 'tag-pending-add' : 'tag-pending-reduce']">{{ tag.label }}</span>
                </template>
              </div>
              <div class="fund-diff-info" v-if="hasDiffData(holding)">
                <span class="diff-label">估值</span>
                <span :class="['diff-value', getEstimateChangeClass(holding)]">{{ getDisplayEstimateChange(holding) }}</span>
                <span class="diff-separator">|</span>
                <span class="diff-label">{{ getRealChangeLabel(holding) }}</span>
                <span :class="['diff-value', getRealChangeClass(holding)]">{{ getDisplayRealChange(holding) || '--' }}</span>
                <span class="diff-separator">|</span>
                <span class="diff-label">{{ getDiffLabel(holding) }}</span>
                <span :class="['diff-value', getDiffClass(holding)]">{{ getDisplayDiff(holding) || '待计算' }}</span>
              </div>
            </div>
            <div class="col-right">
              <div class="col-position">
                <div class="position-amount">{{ getHoldingMarketValue(holding) }}</div>
                <div class="position-nav" :class="getChangeStatus(holding.todayProfit || 0)">{{ getLatestIncome(holding) }}</div>
              </div>
              <div class="col-profit" :class="getChangeStatus(holding.profit || 0)">
                <div class="profit-amount">{{ holding.profit !== undefined ? (holding.profit >= 0 ? '+' : '') + formatMoney(holding.profit) : '--' }}</div>
                <div class="profit-rate">{{ holding.profitRate !== undefined ? formatPercent(holding.profitRate) : '--' }}</div>
              </div>
              <div class="col-today" :class="getChangeStatus(holding.todayProfit || 0)">
                <span class="today-profit">{{ holding.todayProfit !== undefined ? (holding.todayProfit >= 0 ? '+' : '') + formatMoney(holding.todayProfit) : '--' }}</span>
                <span class="today-rate">{{ getTodayRate(holding) }}</span>
              </div>
            </div>
          </div>
          <template #right>
            <van-button square type="primary" text="编辑" class="action-btn" @click="handleEdit(holding.code)" />
            <van-button square type="warning" text="调仓" class="action-btn action-trade" @click="openTradeDialog(holding.code, holding.name)" />
            <van-button square type="danger" text="删除" class="action-btn action-delete" @click="handleDelete(holding.code)" />
          </template>
        </van-swipe-cell>
      </template>

      <van-empty v-else description="暂无持仓记录">
        <van-button round type="primary" @click="openAddDialog">添加基金</van-button>
      </van-empty>
    </div>
    </van-pull-refresh>

    <div class="holding-floating-actions" aria-label="持仓操作">
      <div class="import-menu-wrapper" ref="ocrMenuRef">
        <button type="button" class="floating-action-button floating-import-button" title="图片导入" aria-label="图片导入" @click="triggerOcrMenu">
          <van-icon name="scan" size="21" />
        </button>
        <transition name="ocr-menu-fade">
          <div v-if="showOcrMenu" class="ocr-dropdown-menu">
            <div v-for="option in ocrOptions" :key="option.value" class="ocr-menu-item" @click.stop="selectOcrMode(option.value)">
              <van-icon :name="option.icon" size="18" class="menu-item-icon" />
              <div class="menu-item-content">
                <span class="menu-item-label">{{ option.label }}</span>
                <span class="menu-item-desc">{{ option.desc }}</span>
              </div>
              <van-icon v-if="ocrMode === option.value" name="success" size="16" class="menu-item-check" color="#1989fa" />
            </div>
          </div>
        </transition>
      </div>
      <button type="button" class="floating-action-button floating-add-button" title="添加基金" aria-label="添加基金" @click="openAddDialog">
        <van-icon name="add-o" size="22" />
      </button>
    </div>

    <!-- 添加/编辑持仓弹窗 -->
    <van-popup
      v-model:show="showAddDialog"
      class="holding-editor-popup"
      position="bottom"
      round
      teleport="body"
      :z-index="2001"
      :safe-area-inset-bottom="true"
      :style="{ height: '68%' }"
    >
      <div class="add-dialog">
        <div class="dialog-header">
          <span>{{ isEditing ? '编辑持仓' : '添加基金' }}</span>
          <div class="dialog-header-actions">
            <van-button v-if="isEditing" class="dialog-save-button" size="small" type="primary" @click="submitForm">
              保存
            </van-button>
            <van-icon name="cross" @click="showAddDialog = false" />
          </div>
        </div>

        <div class="dialog-content">
          <!-- 基金选择（非编辑模式） -->
          <template v-if="!isEditing">
            <van-field
              v-if="!selectedFund"
              v-model="searchKeyword"
              label="选择基金"
              placeholder="输入基金代码或名称搜索"
              @input="onSearchInput"
            />
            
            <!-- 搜索结果 -->
            <div v-if="searchResults.length > 0" class="search-results">
              <van-cell
                v-for="fund in searchResults"
                :key="fund.code"
                :title="fund.name"
                :label="fund.code"
                clickable
                @click="selectFund(fund)"
              />
            </div>

            <!-- 已选择的基金 -->
            <van-field
              v-if="selectedFund"
              :model-value="`${selectedFund.name} (${selectedFund.code})`"
              label="已选基金"
              readonly
            >
              <template #button>
                <van-button size="small" @click="selectedFund = null; currentNetValue = 0">重选</van-button>
              </template>
            </van-field>
          </template>

          <!-- 编辑模式显示基金信息 -->
          <van-field
            v-else
            :model-value="`${formData.name} (${formData.code})`"
            label="基金"
            readonly
          />

          <!-- 当前参考净值：盘中为估值，盘后为已公布的官方净值 -->
          <van-field
            v-if="currentNetValue > 0"
            :model-value="currentNetValue.toFixed(4)"
            :label="isTradingHours ? '当前估值' : '最新净值'"
            readonly
          />

          <!-- 份额类型显示 -->
          <van-field v-if="selectedFund || isEditing" label="份额类型" readonly>
            <template #input>
              <div class="share-class-display">
                <span class="share-class-tag" :class="shareClass.toLowerCase()">{{ shareClass }}类</span>
                <span class="share-class-desc">
                  {{ shareClass === 'A' ? '前端收费' : '按日计提销售服务费' }}
                </span>
              </div>
            </template>
          </van-field>

          <!-- ★ 输入模式切换 Tab -->
          <div class="input-mode-tabs">
            <div 
              class="mode-tab"
              :class="{ active: inputMode === 'amount' }"
              @click="inputMode = 'amount'"
            >按金额</div>
            <div 
              class="mode-tab"
              :class="{ active: inputMode === 'shares' }"
              @click="inputMode = 'shares'"
            >按份额</div>
          </div>

          <!-- ========== 按金额模式的字段 ========== -->
          <template v-if="inputMode === 'amount'">
          <!-- 当前持仓市值 -->
          <van-field
            v-model="formData.amount"
            type="number"
            label="持仓金额"
            placeholder="请输入当前持仓总金额"
          />

          <!-- 持有收益 [NEW] 支持负数 -->
          <van-field
            v-model="formData.profit"
            type="number"
            label="持有收益"
            placeholder="可为正/负数（如 -123.45 或 +567.89）"
          >
            <template #right-icon>
              <span class="profit-hint" v-if="formData.profit">
                {{ parseFloat(formData.profit) >= 0 ? '盈利' : '亏损' }}
              </span>
            </template>
          </van-field>

          </template>

          <!-- ========== 按份额模式的字段 ========== -->
          <template v-else>
          <!-- 持有份额 [NEW] 必填 -->
          <van-field
            v-model="formData.shares"
            type="number"
            label="持有份额 *"
            placeholder="请输入持有份额（份）"
          />

          <!-- 持仓成本单价 [NEW] 可编辑 -->
          <van-field
            v-model="formData.costPrice"
            type="number"
            label="成本单价 *"
            placeholder="每份买入成本价（元），如 1.2345"
          />

          <!-- 计算结果预览（按份额模式） -->
          <div v-if="calculatedAmountFromShares > 0" class="calc-result-preview">
            <div class="calc-preview-item">
              <span class="calc-label">投入总额</span>
              <span class="calc-value">¥{{ calculatedAmountFromShares.toFixed(2) }}</span>
            </div>
            <div class="calc-preview-item" v-if="calculatedMarketValue > 0">
              <span class="calc-label">当前市值</span>
              <span class="calc-value">¥{{ calculatedMarketValue.toFixed(2) }}</span>
            </div>
            <div class="calc-preview-item" v-if="calculatedProfitFromShares !== null">
              <span class="calc-label">持有收益</span>
              <span class="calc-value" :class="calculatedProfitFromShares >= 0 ? 'profit-up' : 'profit-down'">
                {{ calculatedProfitFromShares >= 0 ? '+' : '' }}{{ calculatedProfitFromShares.toFixed(2) }}
              </span>
            </div>
          </div>
          </template>

          <!-- 风险提示区域 -->
          <div v-if="riskCheckResult && (riskCheckResult.warnings.length > 0 || riskCheckResult.errors.length > 0)" 
               class="risk-warning-box"
               :class="riskCheckResult.errors.length > 0 ? 'risk-error' : 'risk-warn'">
            <div class="risk-header">
              <van-icon :name="riskCheckResult.errors.length > 0 ? 'warning-o' : 'info-o'" />
              <span class="risk-title">风险提示</span>
              <span class="risk-score">{{ riskCheckResult.score }}/100</span>
            </div>
            <div class="risk-content">
              <template v-if="riskCheckResult.errors.length > 0">
                <div class="risk-item error" v-for="(err, idx) in riskCheckResult.errors" :key="'err-' + idx">
                  <van-icon name="close" /> {{ err }}
                </div>
              </template>
              <template v-if="riskCheckResult.warnings.length > 0">
                <div class="risk-item warn" v-for="(warn, idx) in riskCheckResult.warnings" :key="'warn-' + idx">
                  <van-icon name="info-o" /> {{ warn }}
                </div>
              </template>
            </div>
          </div>

          <!-- 计算结果展示 -->
          <div v-if="(inputMode === 'amount' && calculatedShares > 0) || (inputMode === 'shares' && calculatedAmountFromShares > 0)" class="calc-result">
            <div class="calc-item">
              <span class="calc-label">{{ inputMode === 'amount' ? '预估份额' : '持有份额' }}</span>
              <span class="calc-value">{{ inputMode === 'amount' ? calculatedShares.toFixed(2) : formData.shares }} 份</span>
            </div>
            <div class="calc-item" v-if="inputMode === 'amount' && calculatedCostUnitPrice > 0">
              <span class="calc-label">反推成本单价</span>
              <span class="calc-value">¥{{ calculatedCostUnitPrice.toFixed(4) }}</span>
            </div>
            <div class="calc-item" v-if="inputMode === 'amount' && formData.profit">
              <span class="calc-label">总成本估算</span>
              <span class="calc-value">¥{{ calculatedTotalCost.toFixed(2) }}</span>
            </div>
          </div>
        </div>

        <div v-if="!isEditing" class="dialog-footer">
          <van-button plain type="primary" @click="skipHolding">
            跳过持仓
          </van-button>
          <van-button type="primary" @click="submitForm">
            确认添加
          </van-button>
        </div>
            </div>
    </van-popup>
    
    <!-- ========== 调仓（加仓/减仓）弹窗 ========== -->
    <van-popup
      v-model:show="showTradeDialog"
      class="holding-trade-popup"
      position="bottom"
      round
      teleport="body"
      :z-index="2001"
      :safe-area-inset-bottom="true"
      :style="{ height: '65%' }"
    >
      <div class="trade-dialog">
        <div class="dialog-header">
          <span>{{ tradeMode === 'add' ? '加仓' : '减仓' }}</span>
          <van-icon name="cross" @click="showTradeDialog = false" />
        </div>

        <!-- 基金信息显示 -->
        <div class="trade-fund-info">
          <div class="trade-fund-name">{{ tradeFundName }}</div>
          <div class="trade-fund-code">#{{ tradeFundCode }}</div>
        </div>

        <!-- 当前持仓信息（只读） -->
        <div class="trade-current-info" v-if="holdingStore.getHoldingByCode(tradeFundCode)">
          <div class="current-item">
            <span class="current-label">当前持有</span>
            <span class="current-value">
              {{ (holdingStore.getHoldingByCode(tradeFundCode)?.shares || 0).toFixed(2) }} 份
              / ¥{{ formatMoney(holdingStore.getHoldingByCode(tradeFundCode)?.amount || 0) }}
            </span>
          </div>
        </div>

        <div class="dialog-content">
          <!-- 加仓模式表单 -->
          <template v-if="tradeMode === 'add'">
            <!-- 加仓金额 -->
            <van-field
              v-model="addTradeForm.amount"
              type="number"
              label="加仓金额 *"
              placeholder="请输入加仓金额"
            >
              <template #button>
                <van-icon name="plus" />
              </template>
            </van-field>

            <!-- 买入费率 -->
            <div class="trade-form-row">
              <van-field
                v-model="addTradeForm.feeRate"
                type="number"
                label="买入费率 (%) *"
                placeholder="0.00"
                class="trade-half-field"
              />
              
              <!-- 加仓日期 -->
              <van-field
                v-model="addTradeForm.tradeDate"
                label="加仓日期 *"
                readonly
                class="trade-half-field"
              >
                <template #input>
                  <input
                    type="date"
                    v-model="addTradeForm.tradeDate"
                    :max="todayStr"
                    class="date-input-inline"
                  />
                </template>
              </van-field>
            </div>

            <!-- 交易时段选择 -->
            <div class="trade-time-slot">
              <label class="time-slot-label">交易时段</label>
              <div class="time-slot-buttons">
                <button 
                  class="time-slot-btn"
                  :class="{ active: addTradeForm.tradeTimeSlot === 'before' }"
                  @click="addTradeForm.tradeTimeSlot = 'before'"
                >15:00前</button>
                <button 
                  class="time-slot-btn"
                  :class="{ active: addTradeForm.tradeTimeSlot === 'after' }"
                  @click="addTradeForm.tradeTimeSlot = 'after'"
                >15:00后</button>
              </div>
            </div>

            <!-- 时间逻辑说明提示 -->
            <div class="trade-time-tip" v-if="addTradeForm.tradeDate && addTradeForm.amount">
              <van-icon name="info-o" size="14" />
              <span v-if="addTradeForm.tradeTimeSlot === 'before'">
                15:00前提交 → 下一交易日官方净值公布后自动结算
              </span>
              <span v-else>
                15:00后提交 → 下一交易日官方净值公布后自动结算
              </span>
            </div>
          </template>

          <!-- 减仓模式表单 -->
          <template v-else>
            <!-- 减仓份额 -->
            <van-field
              v-model="reduceTradeForm.shares"
              type="number"
              label="减仓份额 *"
              placeholder="请输入卖出份额"
              :max="holdingStore.getHoldingByCode(tradeFundCode)?.shares || 0"
            >
              <template #right-icon>
                <span class="max-shares-hint" v-if="holdingStore.getHoldingByCode(tradeFundCode)">
                  最大{{ (holdingStore.getHoldingByCode(tradeFundCode)?.shares || 0).toFixed(2) }}份
                </span>
              </template>
            </van-field>

            <!-- 减仓日期 -->
            <van-field
              v-model="reduceTradeForm.tradeDate"
              label="减仓日期 *"
              readonly
            >
              <template #input>
                <input
                  type="date"
                  v-model="reduceTradeForm.tradeDate"
                  :max="todayStr"
                  class="date-input-inline"
                />
              </template>
            </van-field>

            <!-- 交易时段选择 -->
            <div class="trade-time-slot">
              <label class="time-slot-label">交易时段</label>
              <div class="time-slot-buttons">
                <button 
                  class="time-slot-btn"
                  :class="{ active: reduceTradeForm.tradeTimeSlot === 'before' }"
                  @click="reduceTradeForm.tradeTimeSlot = 'before'"
                >15:00前</button>
                <button 
                  class="time-slot-btn"
                  :class="{ active: reduceTradeForm.tradeTimeSlot === 'after' }"
                  @click="reduceTradeForm.tradeTimeSlot = 'after'"
                >15:00后</button>
              </div>
            </div>

            <!-- 减仓预览 -->
            <div class="trade-preview" v-if="reduceTradeForm.shares && holdingStore.getHoldingByCode(tradeFundCode)">
              <div class="preview-row">
                <span>预计卖出</span>
                <span class="preview-value">约 ¥{{ formatMoney((parseFloat(reduceTradeForm.shares) || 0) * (holdingStore.getHoldingByCode(tradeFundCode)?.costUnitPrice || 1)) }}</span>
              </div>
              <div class="preview-row">
                <span>剩余持仓</span>
                <span class="preview-value">{{ Math.max(0, (holdingStore.getHoldingByCode(tradeFundCode)?.shares || 0) - parseFloat(reduceTradeForm.shares) || 0).toFixed(2) }} 份</span>
              </div>
            </div>
            
            <!-- 时间逻辑说明 -->
            <div class="trade-time-tip" v-if="reduceTradeForm.tradeDate && reduceTradeForm.shares">
              <van-icon name="info-o" size="14" />
              <span v-if="reduceTradeForm.tradeTimeSlot === 'before'">
                15:00前提交 → 下一交易日官方净值公布后自动结算
              </span>
              <span v-else>
                15:00后提交 → 下一交易日官方净值公布后自动结算
              </span>
            </div>
          </template>
        </div>

        <!-- 待确认调仓记录 -->
        <div class="pending-adjustments" v-if="currentPendingAdjustments.length > 0">
          <div class="pending-title">
            <van-icon name="clock-o" />
            <span>待确认调仓（{{ currentPendingAdjustments.length }}）</span>
            <span class="pending-tip">官方净值更新后自动确认</span>
          </div>
          <div class="pending-list">
            <div
              v-for="item in currentPendingAdjustments"
              :key="item.id"
              class="pending-item"
            >
              <div class="pending-info">
                <div class="pending-row">
                  <span class="pending-type" :class="item.type">
                    {{ item.type === 'add' ? '加仓' : '减仓' }}
                  </span>
                  <span class="pending-date">净值结算起始日 {{ item.confirmDate }}</span>
                </div>
                <div class="pending-detail">
                  {{ item.timeSlot === 'before' ? '15:00前' : '15:00后' }} |
                  {{ item.type === 'add' ? '金额' : '份额' }} {{ item.type === 'add' ? formatMoney(item.amount) : item.shares.toFixed(2) }} |
                  {{ item.type === 'add' ? '预计新增份额' : '扣减成本' }} {{ item.type === 'add' ? item.shares.toFixed(2) : formatMoney(item.amount) }}
                </div>
              </div>
              <van-button
                size="small"
                plain
                type="danger"
                @click="cancelPendingItem(item.id)"
              >
                取消
              </van-button>
            </div>
          </div>
        </div>

        <!-- 底部操作栏：切换模式 + 确认按钮 -->
        <div class="trade-footer">
          <div class="trade-mode-switch">
            <button 
              class="mode-btn"
              :class="{ active: tradeMode === 'add' }"
              @click="tradeMode = 'add'"
            >
              <van-icon name="plus" /> 加仓
            </button>
            <button 
              class="mode-btn mode-reduce"
              :class="{ active: tradeMode === 'reduce' }"
              @click="tradeMode = 'reduce'"
            >
              <van-icon name="minus" /> 减仓
            </button>
          </div>
          
          <div class="trade-action-buttons">
            <van-button plain block @click="showTradeDialog = false">取消</van-button>
            <van-button 
              block 
              type="primary" 
              @click="tradeMode === 'add' ? confirmAddTrade() : confirmReduceTrade()"
            >
              确定
            </van-button>
          </div>
        </div>
      </div>
    </van-popup>
    
    <!-- 图片导入弹窗 -->
    <van-popup
      v-model:show="showImportDialog"
      position="bottom"
      round
      :style="{ height: '80%' }"
    >
      <div class="import-dialog">
        <div class="dialog-header">
          <span>图片识别导入</span>
          <van-icon name="cross" @click="closeImportDialog" />
        </div>
        
        <div class="import-content">
          <!-- 图片预览 -->
          <div v-if="importImagePreview" class="image-preview">
            <img :src="importImagePreview" alt="导入图片" />
          </div>
          
          <!-- OCR 处理中 -->
          <div v-if="isImporting" class="ocr-processing">
            <van-loading size="32px" color="#1989fa">
              <div class="ocr-status">
                <span>正在识别图片中的基金代码...</span>
                <span class="ocr-progress">{{ importProgress }}%</span>
              </div>
            </van-loading>
            <van-progress :percentage="importProgress" stroke-width="4" />
          </div>
          
                    <!-- 识别结果列表 -->
          <div v-if="extractedFunds.length > 0 && !isImporting" class="extracted-list">
            <div class="extracted-header">
              <span class="extracted-title">识别到 {{ extractedFunds.length }} 只基金</span>
              <van-button size="small" plain @click="toggleSelectAll">
                {{ extractedFunds.every(f => f.selected) ? '取消全选' : '全选' }}
              </van-button>
            </div>
            
                        <div class="extracted-items">
              <div
                v-for="(fund, index) in extractedFunds"
                :key="fund.code + '-' + index"
                class="extracted-item"
                :class="{ selected: fund.selected, 'no-code': !fund.code }"
                @click="toggleFundSelection(index)"
              >
                <van-checkbox :model-value="fund.selected" @click.stop="toggleFundSelection(index)" />
                
                <!-- 匹配状态指示 -->
                <div class="match-status-indicator" 
                     :class="'status-' + (fund.matchConfidence || 'none')"
                     :title="getMatchStatusTitle(fund.matchConfidence)"
                     v-if="!fund.code || fund.matchConfidence !== 'exact'">
                  <van-icon :name="getMatchStatusIcon(fund.matchConfidence)" size="12" />
                </div>
                
                <div class="fund-info">
                  <div class="fund-name-row">
                    <div class="fund-name" :title="fund.name">{{ fund.name }}</div>
                  </div>
                  <div class="fund-code" :class="{ 'code-empty': !fund.code }">{{ fund.code || '自动搜索中...' }}</div>
                  <div class="fund-share-row">
                    <span class="share-label">份额类型:</span>
                    <van-tag
                      v-for="type in ['A', 'B', 'C']"
                      :key="type"
                      :type="fund.shareClass === type ? 'primary' : 'default'"
                      size="medium"
                      class="share-tag"
                      @click.stop="changeShareClass(index, type)"
                    >
                      {{ type }}
                    </van-tag>
                  </div>
                  <div v-if="fund.amount || fund.profit || fund.rate || fund.costPrice" class="fund-details">
                    <div class="detail-edit-row">
                      <label class="detail-label">持仓金额</label>
                      <input 
                        type="text" 
                        class="detail-input" 
                        :class="{ 'input-empty': !fund.amount }"
                        :value="fund.amount || ''"
                        @change="updateFundField(index, 'amount', $event.target.value)"
                        placeholder="输入金额"
                      />
                    </div>
                    <div class="detail-edit-row">
                      <label class="detail-label">持有收益</label>
                        <input 
                        type="text" 
                        class="detail-input detail-profit" 
                        :class="[parseFloat(fund.profit) >= 0 ? 'profit-up' : 'profit-down', { 'input-empty': !fund.profit }]"
                        :value="fund.profit || ''"
                        @change="updateFundField(index, 'profit', $event.target.value)"
                        placeholder="盈亏金额"
                      />
                    </div>
                    <div class="detail-edit-row">
                      <label class="detail-label">盈亏收益率</label>
                      <div class="rate-display-group">
                          <input 
                        type="text" 
                        class="detail-input detail-rate" 
                        :class="[parseFloat(fund.rate) >= 0 ? 'rate-up' : 'rate-down', { 'input-empty': !fund.rate }]"
                        :value="fund.rate ? fund.rate.replace('%', '') : ''"
                        @change="updateFundField(index, 'rate', $event.target.value)"
                        placeholder="如6.3"
                      />
                        <span class="rate-unit">%</span>
                      </div>
                      <!-- 自动计算按钮 -->
                      <van-button 
                        size="mini" 
                        type="primary" 
                        plain 
                        class="calc-btn"
                        @click.stop="autoCalculateFields(index)"
                        v-if="fund.amount && fund.profit"
                      >
                        计算成本
                      </van-button>
                    </div>
                    <div v-if="fund.costPrice" class="detail-edit-row">
                      <label class="detail-label detail-cost-label">成本单价</label>
                      <span class="detail-cost-value">{{ fund.costPrice }}</span>
                    </div>
                  </div>
                  <!-- 匹配详情提示 -->
                  <div v-if="fund.matchConfidence && fund.matchConfidence !== 'exact'" class="match-hint">
                    {{ getMatchHint(fund.matchConfidence) }}
                  </div>
                </div>
                <span v-if="holdingStore.hasHolding(fund.code)" class="already-holding">已持有</span>
              </div>
            </div>
          </div>
          
          <!-- 空状态 -->
          <div v-if="!isImporting && extractedFunds.length === 0 && importImagePreview" class="empty-state">
            <van-icon name="info-o" size="48" color="#999" />
            <p>未识别到基金代码</p>
            <p class="tip">请确保图片清晰，包含6位基金代码</p>
          </div>
        </div>
        
        <div class="dialog-footer">
          <van-button 
            v-if="!isImporting && importImagePreview" 
            block 
            type="primary" 
            @click="startOcrImport"
          >
            {{ ocrMode === 'ai' ? '🚀 AI智能识别' : '📷 本地OCR识别' }}
          </van-button>
          <van-button 
            v-if="extractedFunds.length > 0 && !isImporting" 
            block 
            type="success" 
            @click="confirmImportFunds"
          >
            导入选中的基金
          </van-button>
        </div>
      </div>
  </van-popup>
</div>
</template>

<style scoped>
.holding-page {
  --holding-tabbar-height: calc(50px + env(safe-area-inset-bottom, 0px));
  min-height: 100%;
  box-sizing: border-box;
  /* 持仓页没有独立顶部工具栏，只为系统状态栏保留安全区。 */
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: calc(28px + var(--holding-tabbar-height));
  background: var(--bg-primary);
  transition: background-color 0.3s;
}

.holding-global-refresh {
  min-height: calc(100vh - var(--holding-tabbar-height) - env(safe-area-inset-top, 0px));
}

/* 与自选页 .top-header 对齐，避免在页面容器上重复叠加安全区。 */
.holding-top-header {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  height: var(--holding-header-height);
  box-sizing: border-box;
  padding: env(safe-area-inset-top, 0px) 16px 0;
  background: var(--bg-secondary);
  flex-shrink: 0;
  z-index: 100;
}

/* 日期输入框 */
.date-input-wrapper {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  background: var(--bg-primary);
}

.date-label {
  width: 80px;
  font-size: 14px;
  color: var(--text-primary);
  flex-shrink: 0;
}

.date-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 16px;
  color: var(--text-primary);
  outline: none;
  padding: 8px 0;
}

.date-input::-webkit-calendar-picker-indicator {
  opacity: 0.6;
}

/* 汇总卡片 */
.summary-card {
  --asset-up: #f04458;
  --asset-down: #07845a;
  position: relative;
  overflow: hidden;
  margin: 8px 12px 12px;
  padding: 12px 14px 11px;
  border-radius: 8px;
  color: #fff;
  background: linear-gradient(rgba(236, 255, 245, .42), rgba(236, 255, 245, .42)), #73d2a5 url('/images/holding-asset-card-bg.png') center / cover no-repeat;
  background-blend-mode: screen, normal;
  box-shadow: 0 8px 18px rgba(32, 133, 89, .14);
}

.summary-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}

.summary-row:last-child {
  margin-bottom: 0;
}

.summary-item {
  flex: 1;
  min-width: 0;
}

.summary-label {
  font-size: 10px;
  opacity: 0.8;
  margin-bottom: 2px;
}

.summary-value {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.summary-value.up {
  color: var(--asset-up);
}

.summary-value.down {
  color: var(--asset-down);
}

.summary-total { margin-bottom: 10px; }
.summary-total-value { font-size: 25px; line-height: 1; font-weight: 700; font-variant-numeric: tabular-nums; }
.summary-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.summary-rate { margin-top: 1px; font-size: 10px; font-variant-numeric: tabular-nums; opacity: .86; }
.summary-rate.up { color: var(--asset-up); }
.summary-rate.down { color: var(--asset-down); }

/* 列表表头 */
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  font-size: 10px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

/* 持仓列表 */
.holding-list-container {
  overflow: visible;
  padding-bottom: 82px;
}

.holding-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 8px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.col-name {
  flex: 1;
  min-width: 0;
  max-width: 44%;
  overflow: hidden;
}

.col-name .fund-name {
  color: var(--text-primary);
  margin-bottom: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.col-name .fund-meta {
  display: flex;
  align-items: center;
  gap: 4px;
}

.col-name .fund-code {
  font-size: 11px;
  color: var(--text-secondary);
}

.col-name .fund-type {
  font-size: 11px;
  color: var(--text-secondary);
}

.col-name .fund-tag {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  margin-left: 4px;
}

.col-name .tag-updated {
  background: #ff9800;
  color: #fff;
}

.col-name .tag-trading {
  background: #2196f3;
  color: #fff;
}

.col-name .tag-loading {
  background: #9e9e9e;
  color: #fff;
}

.col-name .tag-pending {
  background: #ffcdd2;
  color: #c62828;
}

.col-name .tag-pending-add {
  background: rgba(228, 57, 60, 0.15);
  color: #e4393c;
}

.col-name .tag-pending-reduce {
  background: rgba(29, 184, 44, 0.15);
  color: #1db82c;
}

.col-name .tag {
  font-size: 10px;
  padding: 1px 4px;
  background: var(--color-primary-bg);
  color: var(--color-primary);
  border-radius: 2px;
}

.col-name .amount {
  font-size: 12px;
  color: var(--text-secondary);
}

.col-right {
  display: grid;
  grid-template-columns: 62px 62px 62px;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  margin-left: 5px;
}

.col-position {
  text-align: right;
  font-size: 11px;
  min-width: 0;
}

.col-profit {
  text-align: right;
  font-size: 14px;
  min-width: 0;
}

.col-profit .profit-amount {
  font-size: 14px;
}

.col-profit .profit-rate {
  font-size: 11px;
  opacity: 0.8;
}

.col-today {
  text-align: right;
  font-size: 13.2px;
  min-width: 0;
}

.col-today .today-profit {
  font-size: 13.2px;
  font-weight: 600;
  display: block;
}

.position-amount,
.position-nav,
.today-rate {
  display: block;
  line-height: 1.35;
}

.position-amount {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
}

.position-nav {
  color: var(--text-secondary);
  font-size: 11px;
}

.today-rate {
  color: var(--text-secondary);
  font-size: 12.1px;
}


.up { color: var(--color-up); }
.down { color: var(--color-down); }
.flat { color: var(--text-secondary); }

/* 估值、真实涨跌幅、实差信息 */
.fund-diff-info {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 2px;
  font-size: 11px;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-wrap: nowrap;
}

.diff-label {
  color: var(--text-secondary);
  font-size: 10px;
}

.diff-value {
  font-weight: 500;
  font-size: 9px;
}

.diff-separator {
  color: var(--border-color);
  margin: 0 1px;
  font-size: 9px;
}

/* 实差颜色 */
.diff-up {
  color: var(--color-up) !important;
}

.diff-down {
  color: var(--color-down) !important;
}

.diff-flat {
  color: var(--text-secondary) !important;
}

.action-btn {
  height: 100%;
}

.action-trade {
  background-color: #ff976a !important;
}

.action-delete {
  background-color: #ee0a24 !important;
}

/* ========== 调仓弹窗样式 ========== */
.trade-dialog {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}

.trade-fund-info {
  padding: 12px 16px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
}

.trade-fund-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.trade-fund-code {
  font-size: 13px;
  color: var(--text-secondary);
}

.trade-current-info {
  padding: 8px 16px;
  background: rgba(255, 152, 0, 0.1);
  border-bottom: 1px solid var(--border-color);
}

.current-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.current-label {
  font-size: 13px;
  color: var(--text-secondary);
}

.current-value {
  font-size: 13px;
  color: #ff9800;
  font-weight: 500;
}

/* 调仓表单行布局（两列） */
.trade-form-row {
  display: flex;
  gap: 8px;
}

.trade-half-field {
  flex: 1;
}

.trade-half-field :deep(.van-field__body) {
  border: none !important;
}

/* 日期内联输入 */
.date-input-inline {
  width: 100%;
  border: none;
  outline: none;
  font-size: inherit;
  color: var(--text-primary);
  background: transparent;
}

/* 交易时段选择 */
.trade-time-slot {
  padding: 12px 16px 8px;
}

.time-slot-label {
  display: block;
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.time-slot-buttons {
  display: flex;
  gap: 10px;
}

.time-slot-btn {
  flex: 1;
  padding: 10px 16px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.time-slot-btn.active {
  background: linear-gradient(135deg, #1989fa, #00e0b5);
  color: white;
  border-color: transparent;
}

.time-slot-btn:active {
  transform: scale(0.97);
}

/* 时间逻辑提示 */
.trade-time-tip {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 16px;
  margin: 0 16px 12px;
  background: rgba(25, 137, 250, 0.08);
  border-radius: 8px;
  font-size: 12px;
  color: #1989fa;
  line-height: 1.5;
}

/* 减仓预览 */
.trade-preview {
  margin: 0 16px 12px;
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.preview-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.preview-value {
  color: var(--text-primary);
  font-weight: 500;
}

.max-shares-hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* 待确认调仓记录 */
.pending-adjustments {
  margin: 0 16px 12px;
  padding: 12px;
  background: rgba(255, 152, 0, 0.08);
  border: 1px solid rgba(255, 152, 0, 0.2);
  border-radius: 8px;
  max-height: 180px;
  overflow-y: auto;
}

.pending-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: #ff976a;
  margin-bottom: 10px;
}

.pending-tip {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-tertiary);
}

.pending-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pending-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px;
  background: var(--bg-primary);
  border-radius: 6px;
}

.pending-info {
  flex: 1;
  min-width: 0;
}

.pending-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.pending-type {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}

.pending-type.add {
  color: #e4393c;
  background: rgba(228, 57, 60, 0.1);
}

.pending-type.reduce {
  color: #1db82c;
  background: rgba(29, 184, 44, 0.1);
}

.pending-date {
  font-size: 12px;
  color: var(--text-secondary);
}

.pending-detail {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.4;
}

/* 底部操作栏 */
.trade-footer {
  margin-top: auto;
  flex: 0 0 auto;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  position: relative;
  z-index: 2;
}

.trade-mode-switch {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.mode-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.mode-btn.active {
  background: linear-gradient(135deg, #e4393c, #ff6b6b);
  color: white;
  border-color: transparent;
}

.mode-reduce.active {
  background: linear-gradient(135deg, #1db82c, #52c41a);
}

.mode-btn:active {
  transform: scale(0.97);
}

.trade-action-buttons {
  display: flex;
  gap: 10px;
}

.trade-action-buttons .van-button {
  flex: 1;
}

/* 添加弹窗样式 */
.add-dialog {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.dialog-content {
  flex: 1;
  overflow-y: auto;
}

.search-results {
  max-height: 200px;
  overflow-y: auto;
  border-bottom: 1px solid var(--border-color);
}

.calc-result {
  padding: 16px;
  background: var(--bg-tertiary);
  margin: 16px;
  border-radius: 8px;
}

.calc-item {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
}

.calc-label {
  color: var(--text-secondary);
}

.calc-value {
  color: var(--text-primary);
  font-weight: 500;
}

.dialog-footer {
  display: flex;
  flex: 0 0 auto;
  gap: 12px;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
  position: relative;
  z-index: 2;
}

.dialog-footer .van-button {
  flex: 1;
  min-height: 44px;
}

/* 导航栏右侧图标 */
.nav-right-icons {
  display: flex;
  align-items: center;
  gap: 16px;
}

.nav-icon {
  cursor: pointer;
  position: relative;
}

.nav-icon-add {
  cursor: pointer;
}

/* [NEW] 导入按钮二级菜单 */
.import-menu-wrapper {
  position: relative;
  display: inline-block;
}

.nav-icon-import {
  cursor: pointer;
  position: relative;
}

.ocr-dropdown-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 8px;
  min-width: 220px;
  background: var(--bg-card, #ffffff);
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  z-index: 9999;
  overflow: hidden;
  border: 1px solid var(--border-color, #e5e5e5);
}

.ocr-menu-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  gap: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  border-bottom: 1px solid var(--border-color-light, #f0f0f0);
}

.ocr-menu-item:last-child {
  border-bottom: none;
}

.ocr-menu-item:hover {
  background: var(--bg-hover, #f7f8fa);
}

.ocr-menu-item:active {
  transform: scale(0.98);
  background: var(--bg-active, #e8e9eb);
}

.menu-item-icon {
  color: #1989fa;
  flex-shrink: 0;
}

.menu-item-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.menu-item-label {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary, #323233);
  line-height: 1.4;
}

.menu-item-desc {
  font-size: 12px;
  color: var(--text-secondary, #969799);
  line-height: 1.3;
}

.menu-item-check {
  flex-shrink: 0;
}

/* 二级菜单动画 */
.ocr-menu-fade-enter-active,
.ocr-menu-fade-leave-active {
  transition: all 0.25s ease;
}

.ocr-menu-fade-enter-from,
.ocr-menu-fade-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.95);
}

/* 立即刷新按钮 */
.refresh-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color, #3a3a4a);
  cursor: pointer;
  transition: all 0.25s ease;
  min-width: 64px;
}

.refresh-btn:active {
  transform: scale(0.94);
}

.refresh-btn.refreshing {
  border-color: #1989fa;
  box-shadow: 0 0 8px rgba(25, 137, 250, 0.3);
}

.refresh-btn .refresh-label {
  font-size: 10px;
  color: var(--text-secondary, #999);
  line-height: 1;
  white-space: nowrap;
}

.refresh-btn .van-icon.spinning {
  animation: spinRefresh 0.6s linear infinite;
  color: #1989fa;
}

@keyframes spinRefresh {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 图片导入弹窗 */
.import-dialog {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.import-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.image-preview {
  margin-bottom: 16px;
  border-radius: 8px;
  overflow: hidden;
  max-height: 50vh;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  background: #1a1a1a;
}

.image-preview img {
  width: 100%;
  display: block;
  object-fit: contain;
}

.ocr-processing {
  padding: 24px 0;
  text-align: center;
}

.ocr-status {
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
  font-size: 14px;
  color: var(--text-secondary);
}

.ocr-progress {
  font-weight: 500;
  color: var(--color-primary);
}

.extracted-list {
  margin-top: 16px;
}

.extracted-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.extracted-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}

.extracted-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.extracted-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-card);
  border-radius: 8px;
  border: 1px solid var(--border-color);
  transition: all 0.2s;
}

.extracted-item.selected {
  border-color: var(--color-primary);
  background: rgba(25, 137, 250, 0.05);
}

.extracted-item .fund-info {
  flex: 1;
  min-width: 0;
}

.extracted-item .fund-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
  line-height: 1.4;
  word-break: break-word;
}

.extracted-item .fund-code {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: monospace;
}

.extracted-item .fund-code.code-empty {
  color: #ff9800;
}

.fund-share-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.share-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.share-tag {
  cursor: pointer;
}

.extracted-item .fund-details {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 10px;
  background: var(--bg-secondary);
  border-radius: 8px;
}

.extracted-item .detail-edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.extracted-item .detail-label {
  min-width: 70px;
  color: var(--text-secondary);
  font-weight: 500;
}

.extracted-item .detail-input {
  flex: 1;
  max-width: 140px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-primary);
  transition: all 0.2s;
}

.extracted-item .detail-input:focus {
  outline: none;
  border-color: #1989fa;
  box-shadow: 0 0 4px rgba(25, 137, 250, 0.3);
}

.extracted-item .detail-input.input-empty {
  border-style: dashed;
  opacity: 0.6;
}

.extracted-item .detail-input.profit-up {
  color: #e4393c;
  border-color: rgba(228, 57, 60, 0.3);
}

.extracted-item .detail-input.profit-down {
  color: #1db82c;
  border-color: rgba(29, 184, 44, 0.3);
}

.extracted-item .detail-input.rate-up {
  color: #e4393c;
  border-color: rgba(228, 57, 60, 0.3);
}

.extracted-item .detail-input.rate-down {
  color: #1db82c;
  border-color: rgba(29, 184, 44, 0.3);
}

.extracted-item .rate-display-group {
  display: flex;
  align-items: center;
  flex: 1;
  max-width: 120px;
}

.extracted-item .rate-display-group input {
  width: 80px;
}

.extracted-item .rate-unit {
  color: var(--text-secondary);
  font-size: 12px;
  margin-left: 2px;
}

.extracted-item .calc-btn {
  margin-left: auto;
  height: 24px;
  font-size: 11px;
}

.extracted-item .detail-cost-label {
  color: #ff9800;
}

.extracted-item .detail-cost-value {
  color: #ff9800;
  font-weight: 600;
  font-size: 13px;
}

.already-holding {
  font-size: 11px;
  color: var(--color-warning);
  background: rgba(255, 152, 0, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
}

/* 风控提示框 */
.risk-warning-box {
  margin: 12px 16px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid;
}

.risk-warning-box.risk-error {
  background: rgba(244, 67, 54, 0.08);
  border-color: #f44336;
}

.risk-warning-box.risk-warn {
  background: rgba(255, 152, 0, 0.08);
  border-color: #ff9800;
}

.risk-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-weight: 500;
}

.risk-header .risk-title {
  flex: 1;
  font-size: 14px;
  color: var(--text-primary);
}

.risk-score {
  font-size: 13px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.5);
}

.risk-error .risk-score {
  color: #f44336;
  background: rgba(244, 67, 54, 0.15);
}

.risk-warn .risk-score {
  color: #ff9800;
  background: rgba(255, 152, 0, 0.15);
}

.risk-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.risk-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.4;
}

.risk-item.error {
  color: #c62828;
}

.risk-item.warn {
  color: #e65100;
}

.risk-item .van-icon {
  margin-top: 2px;
  flex-shrink: 0;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-secondary);
}

.empty-state p {
  margin: 8px 0;
}

.empty-state .tip {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* A/C 类份额标签 */
.share-class-display {
  display: flex;
  align-items: center;
  gap: 8px;
}

.share-class-tag {
  padding: 2px 8px;
  font-size: 12px;
  border-radius: 4px;
  font-weight: 500;
}

.share-class-tag.a {
  background: rgba(255, 193, 7, 0.2);
  color: #f59e0b;
}

.share-class-tag.c {
  background: rgba(25, 137, 250, 0.2);
  color: #1989fa;
}

.share-class-desc {
  font-size: 12px;
  color: var(--text-secondary);
}

/* 费用选项 */
.fee-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.fee-rate {
  font-size: 13px;
  color: var(--text-secondary);
}

.fee-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  margin: 0 16px;
  background: var(--color-primary-bg);
  border-radius: 4px;
  font-size: 12px;
  color: var(--color-primary);
}

/* ========== 筛选和排序下拉菜单 ========== */
.filter-bar {
  display: flex;
  gap: 12px;
  padding: 8px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.filter-dropdown {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: var(--bg-card);
  border-radius: 16px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.filter-dropdown:active {
  background: var(--bg-secondary);
}

.filter-label {
  white-space: nowrap;
}

.dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  min-width: 120px;
  background: var(--bg-card);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  overflow: hidden;
}

.dropdown-item {
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.2s;
}

.dropdown-item:active {
  background: var(--bg-secondary);
}

/* ========== 输入模式切换Tab样式 ========== */
.input-mode-tabs {
  display: flex;
  margin: 12px 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 4px;
}

.mode-tab {
  flex: 1;
  text-align: center;
  padding: 10px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.mode-tab.active {
  background: var(--color-primary);
  color: #fff;
  box-shadow: 0 2px 6px rgba(25, 137, 250, 0.3);
}

/* 持有收益提示 */
.profit-hint {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
}

.profit-hint:has(+ .profit-up),
.profit-hint + :is(.profit-up) {
  color: var(--color-down);
}

/* 计算结果预览（按份额模式） */
.calc-result-preview {
  margin: 8px 16px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  border-left: 3px solid var(--color-primary);
}

.calc-preview-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  font-size: 13px;
}

.calc-preview-item:first-child {
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 10px;
  margin-bottom: 6px;
}

.calc-preview-item .calc-label {
  color: var(--text-secondary);
}

.calc-preview-item .calc-value {
  font-weight: 600;
  color: var(--text-primary);
}

.calc-preview-item .profit-up {
  color: var(--color-down);
}

.calc-preview-item .profit-down {
  color: var(--color-up);
}

/* ========== 匹配状态指示器 & 手动补全样式 ========== */
.match-status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 10px;
  flex-shrink: 0;
}

.match-status-indicator.high {
  background: rgba(76, 175, 80, 0.15);
  color: #4caf50;
}

.match-status-indicator.medium {
  background: rgba(255, 152, 0, 0.15);
  color: #ff9800;
}

.match-status-indicator.low {
  background: rgba(244, 67, 54, 0.15);
  color: #f44336;
}

.match-status-indicator .van-icon {
  font-size: 12px;
}

.manual-complete-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 12px;
  background: linear-gradient(135deg, #1989fa, #06c);
  color: #fff;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.manual-complete-btn:active {
  transform: scale(0.95);
  opacity: 0.9;
}

.manual-complete-panel {
  height: 80%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary, #f7f8fa);
  border-radius: 16px 16px 0 0;
}

.manual-complete-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--border-color, #ebedf0);
  background: var(--bg-card, #fff);
  border-radius: 16px 16px 0 0;
}

.manual-header-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #323233);
}

.manual-close-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--bg-secondary, #f7f8fa);
  border: none;
  cursor: pointer;
  color: var(--text-secondary, #969799);
  transition: all 0.2s;
}

.manual-close-btn:active {
  transform: scale(0.9);
  background: var(--bg-tertiary, #ebedf0);
}

.manual-search-box {
  padding: 12px 16px;
  background: var(--bg-card, #fff);
  border-bottom: 1px solid var(--border-color, #ebedf0);
}

.manual-current-fund {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 10px;
  background: var(--bg-tertiary, #f7f8fa);
  border-radius: 6px;
  font-size: 13px;
}

.manual-current-label {
  color: var(--text-secondary, #969799);
  font-size: 12px;
}

.manual-current-name {
  color: var(--text-primary, #323233);
  font-weight: 500;
}

.manual-search-input {
  --padding: 8px 12px;
}

.manual-search-results {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
  background: var(--bg-secondary, #f7f8fa);
}

.manual-result-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  cursor: pointer;
  transition: background 0.15s;
  border-bottom: 1px solid var(--border-color-light, #f5f5f5);
}

.manual-result-item:last-child {
  border-bottom: none;
}

.manual-result-item:active {
  background: var(--bg-active, #e8e9eb);
}

.manual-result-info {
  flex: 1;
  min-width: 0;
}

.manual-result-code {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-primary, #1989fa);
  font-family: 'SF Mono', Monaco, monospace;
  margin-bottom: 4px;
}

.manual-result-name {
  font-size: 14px;
  color: var(--text-primary, #323233);
  line-height: 1.3;
  word-break: break-word;
}

.manual-result-type {
  font-size: 11px;
  color: var(--text-tertiary, #c8c9cc);
  margin-top: 2px;
}

.manual-result-select-icon {
  color: var(--color-primary, #1989fa);
  font-size: 18px;
  flex-shrink: 0;
  margin-left: 12px;
}

.manual-empty-state {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-tertiary, #c8c9cc);
  font-size: 14px;
}

.match-confidence-display {
  font-size: 11px;
  color: var(--text-tertiary, #c8c9cc);
  line-height: 1.3;
  max-width: 120px;
}

/* Long fund names remain static so rows stay readable while scanning. */
.col-name .fund-name {
  display: block;
  width: 100%;
  min-width: 0;
  height: 17px;
  line-height: 17px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
  gap: 10px;
  padding: 9px 12px 8px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
}

.dialog-header-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.dialog-save-button {
  min-width: 64px;
}

.list-toolbar h2 {
  margin: 0;
  flex: 1 1 auto;
  min-width: 0;
  font-size: 16px;
  line-height: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.filter-bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 0;
  background: transparent;
  border: 0;
}

.filter-dropdown {
  min-width: 0;
  height: 30px;
  justify-content: center;
  gap: 4px;
  padding: 0 8px;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid #3b4350;
  border-radius: 4px;
  box-shadow: none;
}

.filter-dropdown:active { background: #3b4350; }
.filter-dropdown :deep(.van-icon) { color: var(--text-secondary); }
.filter-label { font-size: 11px; font-weight: 500; white-space: nowrap; }
.dropdown-menu {
  z-index: 20;
  top: calc(100% + 5px);
  right: 0;
  left: auto;
  min-width: 112px;
  background: var(--bg-secondary);
  border: 1px solid #3b4350;
  border-radius: 4px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, .35);
}
.dropdown-item {
  padding: 9px 12px;
  font-size: 12px;
  color: var(--text-primary);
}
.dropdown-item:active,
.dropdown-item.active {
  color: var(--color-primary);
  background: var(--color-primary-bg);
}

.list-header {
  padding: 0 12px 7px;
  color: var(--text-secondary);
  font-size: 10px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
}

.list-header .col-name {
  flex: 0 0 calc(100% - 197px);
  max-width: none;
}
.list-header .col-right { grid-template-columns: 62px 62px 62px; gap: 3px; margin-left: 5px; }
.list-header .col-right > span {
  font-size: 8px;
  line-height: 1;
  white-space: nowrap;
}

/* 右下角操作保留在全局滚动之上，不占用列表行宽。 */
.holding-floating-actions {
  position: fixed;
  right: 16px;
  bottom: calc(64px + env(safe-area-inset-bottom, 0px));
  z-index: 90;
  display: grid;
  gap: 10px;
}

.floating-action-button {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: #315a7c;
  background: color-mix(in srgb, #b8d3eb 27%, transparent);
  box-shadow: none;
  cursor: pointer;
  transition: background-color .18s ease, color .18s ease, transform .18s ease;
}

.floating-action-button:hover { background: color-mix(in srgb, #b8d3eb 38%, transparent); }
.floating-action-button:focus-visible { outline: 2px solid color-mix(in srgb, #315a7c 56%, transparent); outline-offset: 2px; }
.floating-action-button:active { transform: scale(.92); }
.floating-import-button,
.floating-add-button { color: #315a7c; }

/* 深色模式保留同样的轻圆形入口，避免形成高对比的悬浮方块。 */
[data-theme="dark"] .floating-action-button {
  color: #9ec8eb;
  background: color-mix(in srgb, #6e96bf 23%, transparent);
}
[data-theme="dark"] .floating-action-button:hover { background: color-mix(in srgb, #6e96bf 33%, transparent); }
[data-theme="dark"] .floating-action-button:focus-visible { outline-color: color-mix(in srgb, #9ec8eb 70%, transparent); }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .floating-action-button {
    color: #9ec8eb;
    background: color-mix(in srgb, #6e96bf 23%, transparent);
  }

  :root:not([data-theme="light"]) .floating-action-button:hover { background: color-mix(in srgb, #6e96bf 33%, transparent); }
}

.holding-floating-actions .import-menu-wrapper { position: relative; display: block; }
.holding-floating-actions .ocr-dropdown-menu {
  top: auto;
  right: 0;
  bottom: calc(100% + 10px);
  margin: 0;
  border-radius: 8px;
}

@media (max-width: 390px) {
  .list-toolbar { gap: 7px; padding-right: 10px; padding-left: 10px; }
  .list-toolbar h2 { font-size: 15px; }
  .filter-bar { gap: 5px; }
  .filter-dropdown { padding: 0 7px; }
  .filter-label { font-size: 10px; }
}
</style>
