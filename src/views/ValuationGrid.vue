<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import { useRouter } from 'vue-router'
import Sortable from 'sortablejs'
import { useHoldingStore } from '@/stores/holding'
import { getJdFundLink } from '@/utils/format'
import { mergeStrategyOrder, sortByStrategyOrder } from '@/utils/gridStrategyOrder'
import {
  calculateGridConversionTransferIn,
  resolveGridTradeConfirmationDate,
  resolveGridTradeDirection
} from '@/utils/gridTradeImport'
import {
  createGridBuy,
  createGridWatch,
  deleteGridBatch,
  deleteGridSellRecord,
  clearGridVolSensitivity,
  fetchGridFitness,
  fetchGridFundName,
  fetchGridHistory,
  fetchGridPosition,
  fetchGridPositions,
  fetchGridSignals,
  fetchGridState,
  fetchGridValuations,
  fetchGridVolSensitivity,
  fetchMarketRegime,
  recalibrateGridVolSensitivity,
  recognizeGridTrades,
  removeGridPosition,
  saveGridState,
  saveMarketRegime,
  sellGridBatch,
  sellGridPositionFifo,
  updateGridBuyNav,
  updateGridFeeSchedule,
  updateGridVolSensitivity,
  updateGridPositionConfig,
  updateGridSellNav,
  type GridFeeScheduleItem,
  type GridFitness,
  type GridBatch,
  type GridMutationResult,
  type GridPortfolioBudget,
  type GridFund,
  type GridPosition,
  type GridSector,
  type GridSignal,
  type GridState,
  type GridTradeOcrItem,
  type GridValuation,
  type GridVolSensitivity,
  type MarketRegime
} from '@/api/gridNative'

defineOptions({ name: 'ValuationGrid' })

const props = defineProps<{
  mode: 'valuation' | 'strategy'
}>()

const router = useRouter()
const holdingStore = useHoldingStore()
const state = ref<GridState>({ sectors: [] })
const valuations = ref<Record<string, GridValuation>>({})
const fitnessScores = ref<Record<string, GridFitness>>({})
const valuationFundNames = ref<Record<string, string>>({})
const loading = ref(false)
const refreshing = ref(false)
const strategyRefreshing = ref(false)
const hasLoaded = ref(false)
const lastUpdatedAt = ref('')
const loadError = ref('')
const activeSectorIndex = ref(0)
const collapsedStrategyFunds = ref(new Set<string>())
const strategyCollapseInitialized = ref(false)
const strategyListRef = ref<HTMLElement | null>(null)
const strategyOrderStorageKey = 'fund-app:grid-strategy-order:v1'
const strategyOrder = ref(readStoredStrategyOrder())
let strategySortable: Sortable | undefined
const sectorDrafts = reactive<Record<number, { code: string; alias: string; lookingUp: boolean }>>({})
const addSectorOpen = ref(false)
const newSectorName = ref('')
const historyOpen = ref(false)
const historyTitle = ref('')
const historyLoading = ref(false)
const history = ref<Array<{ date?: string; nav?: number; change?: number | null }>>([])
const explanationOpen = ref(false)
const explanationKind = ref<'confidence' | 'fitness'>('confidence')

const signals = ref<GridSignal[]>([])
const positions = ref<Record<string, GridPosition>>({})
const strategyFundNames = ref<Record<string, string>>({})
const regime = ref<MarketRegime>({ regime: 'neutral', auto: true, manual: false })
const generatedAt = ref('')
const portfolioBudget = ref<GridPortfolioBudget>({})
const strategyLoadedAt = ref(0)
const positionEditorOpen = ref(false)
const positionSaving = ref(false)
const tradeImageInput = ref<HTMLInputElement | null>(null)
const tradeImportOpen = ref(false)
const tradeImportRecognizing = ref(false)
const tradeImportSaving = ref(false)
const tradeImportStatus = ref('')
const tradeImportFundName = ref('')
const tradeImportHistory = ref<Record<string, Record<string, number>>>({})
const sellEditorOpen = ref(false)
const sellSaving = ref(false)
const settingsOpen = ref(false)
const maxPositionEditorOpen = ref(false)
const feeScheduleEditorOpen = ref(false)
const volSensitivityEditorOpen = ref(false)
const parameterSaving = ref(false)
const activePositionKey = ref('')
const positionOwner = ref('')
const activePosition = ref<GridPosition | null>(null)
const positionForm = reactive({
  code: '',
  importedHoldingCode: '',
  buyRows: [{ amount: '', buyDate: todayString() }],
  nav: '',
  note: '',
  maxPosition: '5000',
  isRebuy: false,
  pendingRebuyId: ''
})
const sellForm = reactive({ shares: '', nav: '', sellDate: todayString() })
const maxPositionForm = reactive({ value: '5000' })
const feeScheduleForm = reactive({ value: '7:1.5,30:0.5,0:0' })
const volSensitivity = ref<GridVolSensitivity>({})
const volSensitivityValue = ref(1)
const volSensitivityLoading = ref(false)
const strategyInfoOpen = ref(false)
const strategyInfoSignal = ref<GridSignal | null>(null)
const batchSellOpen = ref(false)
const batchSellSaving = ref(false)
const activeBatch = ref<{ id: string; shares: number; amount?: number; nav?: number | null; buyDate?: string; note?: string } | null>(null)
const batchSellForm = reactive({ shares: '', nav: '', sellDate: todayString() })
const buyNavEditorOpen = ref(false)
const buyNavSaving = ref(false)
const buyNavTarget = ref<{ fundKey: string; batchId: string; buyDate?: string; amount?: number; currentNav?: number | null } | null>(null)
const buyNavForm = reactive({ value: '' })
type TradeImportRow = GridTradeOcrItem & {
  id: string
  included: boolean
  amount: string
  shares: string
  nav: string
  navDate: string
  sourceShares: string
  sourceNav: string
  sourceNavDate: string
  screenshotFundName: string
  screenshotFundCode: string
  status: 'pending' | 'imported' | 'failed'
}
const tradeImportRows = ref<TradeImportRow[]>([])
const pullRefreshing = ref(false)
let strategyRefreshTimer: ReturnType<typeof window.setInterval> | undefined
let strategyRefreshInFlight: Promise<void> | undefined
const strategyRefreshIntervalMs = 20_000
let valuationRefreshTimer: ReturnType<typeof window.setInterval> | undefined
let valuationRefreshInFlight: Promise<void> | undefined
let valuationLoadInFlight: Promise<void> | undefined
const valuationRefreshIntervalMs = 15_000

const valuationCacheKey = 'fund-app:native-valuation:v2'
const legacyValuationCacheKey = 'fund-app:native-valuation:v1'
const strategyCacheKey = 'fund-app:native-strategy:v1'
const valuationCacheFreshMs = 2 * 60 * 1000

const isValuation = computed(() => props.mode === 'valuation')
const isPageRefreshing = computed(() => refreshing.value || strategyRefreshing.value)
const pageTitle = computed(() => isValuation.value ? '实时估值' : '低频网格')
const allCodes = computed(() => [...new Set(
  state.value.sectors.flatMap((sector) => sector.funds.map((fund) => fund.code).filter(Boolean))
)])
const sortedSectors = computed(() => state.value.sectors.map((sector, index) => ({
  sector,
  index,
  funds: [...sector.funds].sort((left, right) => {
    const rightChange = valueFor(right.code).estimation_change ?? -Infinity
    const leftChange = valueFor(left.code).estimation_change ?? -Infinity
    return rightChange - leftChange
  })
})))
const activeSector = computed(() => (
  sortedSectors.value.find(({ index }) => index === activeSectorIndex.value)
  || sortedSectors.value[0]
))
watch(() => state.value.sectors.length, (length) => {
  if (!length) {
    activeSectorIndex.value = 0
  } else if (activeSectorIndex.value >= length) {
    activeSectorIndex.value = length - 1
  }
})
const strategyRows = computed(() => {
  const rows = signals.value.map((signal) => {
    const code = signal.fund_code.split('__')[0]
    return { signal, code, position: positions.value[signal.fund_code] || positions.value[code] }
  })
  const order = mergeStrategyOrder(strategyOrder.value, rows.map(row => row.signal.fund_code))
  return sortByStrategyOrder(rows, order, row => row.signal.fund_code)
})
const budgetPercent = computed(() => {
  const max = Number(portfolioBudget.value.max_invest) || 0
  const invested = Number(portfolioBudget.value.invested) || 0
  return max > 0 ? Math.min(100, Math.round(invested / max * 100)) : 0
})
const budgetAvailable = computed(() => Math.max(0, (Number(portfolioBudget.value.max_invest) || 0) - (Number(portfolioBudget.value.invested) || 0)))

function valueFor(code: string): GridValuation {
  return valuations.value[code] || { fund_code: code }
}

function hasGridValue(value: unknown) {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value !== 'string' || value.trim().length > 0
}

function mergeValuation(current: GridValuation | undefined, incoming: GridValuation): GridValuation {
  if (!current) return incoming

  const merged = { ...current, ...incoming } as Record<string, unknown>
  // Providers can occasionally return an incomplete fallback quote. Keep the
  // last complete values visible until that provider recovers.
  for (const field of ['fund_name', 'estimation_change', 'week_change', 'month_change', 'confidence', 'calibrated_confidence']) {
    if (!hasGridValue(incoming[field as keyof GridValuation]) && hasGridValue(current[field as keyof GridValuation])) {
      merged[field] = current[field as keyof GridValuation]
    }
  }
  return merged as GridValuation
}

function draftFor(index: number) {
  return sectorDrafts[index] ||= { code: '', alias: '', lookingUp: false }
}

function formatPercent(value?: number | null) {
  if (!Number.isFinite(value)) return '--'
  return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`
}

function formatMoney(value?: number | null, digits = 2) {
  return Number.isFinite(value) ? `¥${Number(value).toFixed(digits)}` : '--'
}

function changeClass(value?: number | null) {
  if (!Number.isFinite(value)) return 'flat'
  return Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat'
}

function regimeLabel(value?: string) {
  if (value === 'bull') return '牛市'
  return value === 'bear' ? '熊市' : '震荡'
}

function regimeIcon(value?: string) {
  if (value === 'bull') return '🐂'
  return value === 'bear' ? '🐻' : '⚖️'
}

function confidence(value: GridValuation) {
  const score = Number(value.calibrated_confidence ?? value.confidence)
  return Number.isFinite(score) ? `${Math.round(score * 100)}%` : '--'
}

function todayString() {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function splitPositionKey(fundKey: string) {
  const [code, ...ownerParts] = fundKey.split('__')
  return { code, owner: ownerParts.join('__') }
}

function formatFeeSchedule(schedule?: GridFeeScheduleItem[]) {
  if (!schedule?.length) return '7:1.5,30:0.5,0:0'
  return schedule.map((item) => `${item.days || 0}:${item.rate}`).join(',')
}

function parseFeeSchedule(input: string): GridFeeScheduleItem[] {
  const schedule = input.split(',').map((part) => {
    const [daysInput, rateInput] = part.trim().split(':')
    const days = Number(daysInput)
    const rate = Number(rateInput)
    if (!Number.isFinite(days) || !Number.isFinite(rate) || rate < 0) throw new Error('费率格式应为 天数:百分比，例如 7:1.5,30:0.5,0:0')
    return { days: days > 0 ? Math.floor(days) : null, rate }
  })
  if (!schedule.length) throw new Error('请填写费率')
  return schedule
}

function displayName(fund: GridFund) {
  return fund.alias || valueFor(fund.code).fund_name || valuationFundNames.value[fund.code] || fund.code
}

function goToFundDetail(code: string) {
  router.push(`/detail/${code}`)
}

function scoreFor(code: string) {
  const score = Number(fitnessScores.value[code]?.score)
  return Number.isFinite(score) ? Math.round(score) : null
}

function scoreClassForValue(score: number) {
  if (score >= 70) return 'grade-a'
  if (score >= 55) return 'grade-b'
  if (score >= 40) return 'grade-c'
  return 'grade-d'
}

function scoreClass(code: string) {
  return scoreClassForValue(scoreFor(code) ?? 0)
}

function strategyScoreFor(row: { signal: GridSignal; code: string }) {
  const score = Number(row.signal.market_analysis?.fitness_score ?? fitnessScores.value[row.code]?.score)
  return Number.isFinite(score) ? Math.round(score) : null
}

function openExplanation(kind: 'confidence' | 'fitness') {
  explanationKind.value = kind
  explanationOpen.value = true
}

const explanationTitle = computed(() => explanationKind.value === 'confidence' ? '置信度说明' : '基金适配评分说明')
const explanationText = computed(() => explanationKind.value === 'confidence'
  ? '置信度反映本次实时估值可用数据的完整度与模型校准程度。数值越高，代表当前估值参考的稳定性越好；它不表示涨跌方向或投资建议。'
  : '基金适配评分由现有基金适配度计算结果提供，用于衡量基金与当前网格策略的匹配程度。分数越高代表匹配度越高，不代表未来收益。')

function toggleStrategyFund(fundKey: string) {
  const next = new Set(collapsedStrategyFunds.value)
  if (next.has(fundKey)) next.delete(fundKey)
  else next.add(fundKey)
  collapsedStrategyFunds.value = next
}

function readStoredStrategyOrder() {
  try {
    const value = JSON.parse(localStorage.getItem(strategyOrderStorageKey) || '[]')
    return Array.isArray(value) ? value.filter(key => typeof key === 'string' && key) : []
  } catch {
    return []
  }
}

function writeStoredStrategyOrder(order: string[]) {
  try {
    localStorage.setItem(strategyOrderStorageKey, JSON.stringify(order))
  } catch {
    // Server persistence remains available when local storage is unavailable.
  }
}

function applyStateStrategyOrder(nextState: GridState) {
  const serverOrder = Array.isArray(nextState.strategy_order) ? nextState.strategy_order.filter(Boolean) : []
  if (serverOrder.length) {
    strategyOrder.value = serverOrder
    writeStoredStrategyOrder(serverOrder)
  } else if (strategyOrder.value.length) {
    nextState.strategy_order = [...strategyOrder.value]
  }
}

async function persistStrategyOrder(order: string[]) {
  strategyOrder.value = order
  state.value = { ...state.value, strategy_order: order }
  writeStoredStrategyOrder(order)
  try {
    await saveGridState(state.value)
    showToast('基金排序已保存')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '基金排序保存失败')
  }
}

function destroyStrategySortable() {
  strategySortable?.destroy()
  strategySortable = undefined
}

async function setupStrategySortable() {
  destroyStrategySortable()
  if (isValuation.value) return
  await nextTick()
  if (!strategyListRef.value) return

  strategySortable = Sortable.create(strategyListRef.value, {
    animation: 160,
    delay: 420,
    delayOnTouchOnly: false,
    touchStartThreshold: 5,
    draggable: '.signal-card-collapsed',
    handle: '.signal-header',
    forceFallback: true,
    fallbackOnBody: true,
    chosenClass: 'signal-card-chosen',
    ghostClass: 'signal-card-ghost',
    fallbackClass: 'signal-card-dragging',
    onEnd(event) {
      const order = [...event.to.querySelectorAll<HTMLElement>('[data-fund-key]')]
        .map(card => card.dataset.fundKey || '')
        .filter(Boolean)
      if (order.length) void persistStrategyOrder(order)
    }
  })
}

async function saveState() {
  try {
    await saveGridState(state.value)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '保存失败')
  }
}

async function refreshValuations() {
  if (!allCodes.value.length) return
  if (valuationRefreshInFlight) return valuationRefreshInFlight

  refreshing.value = true
  const codes = [...allCodes.value]
  const refreshPromise = (async () => {
    try {
      const [items, scores] = await Promise.all([
        fetchGridValuations(codes),
        fetchGridFitness().catch(() => null)
      ])
      const nextValuations = items.filter((item) => item?.fund_code).reduce<Record<string, GridValuation>>((next, item) => {
        next[item.fund_code] = mergeValuation(valuations.value[item.fund_code], item)
        return next
      }, {})
      valuations.value = { ...valuations.value, ...nextValuations }
      // Keep the persisted snapshot during a transient API failure. A non-empty
      // live response is a complete backend cache snapshot and replaces it.
      if (scores && Object.keys(scores).length > 0) fitnessScores.value = scores
      rememberValuationFundNames()
      lastUpdatedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      writeValuationCache()
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : '估值加载失败'
    } finally {
      refreshing.value = false
      valuationRefreshInFlight = undefined
    }
  })()
  valuationRefreshInFlight = refreshPromise
  return refreshPromise
}

async function loadValuation(force = false) {
  if (valuationLoadInFlight) return valuationLoadInFlight

  loadError.value = ''
  const cachedAt = restoreValuationCache()
  if (!force && cachedAt && Date.now() - cachedAt < valuationCacheFreshMs) {
    // Render cached values immediately, then let a fresh confidence/fitness
    // result replace that snapshot as soon as it arrives.
    await refreshValuations()
    return
  }
  loading.value = !state.value.sectors.length
  const loadPromise = (async () => {
    try {
      const [nextState, scores] = await Promise.all([fetchGridState(), fetchGridFitness().catch(() => ({}))])
      state.value = nextState
      applyStateStrategyOrder(state.value)
      if (Object.keys(scores).length > 0) fitnessScores.value = scores
      rememberValuationFundNames()
      await refreshValuations()
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : '估值页面加载失败'
    } finally {
      loading.value = false
      valuationLoadInFlight = undefined
    }
  })()
  valuationLoadInFlight = loadPromise
  return loadPromise
}

async function refreshStrategy(force = false) {
  if (strategyRefreshInFlight) return strategyRefreshInFlight
  const restoredFromCache = !force && restoreStrategyCache()
  loading.value = !restoredFromCache
  strategyRefreshing.value = true
  loadError.value = ''
  const refreshPromise = (async () => {
    try {
      const [signalData, positionData, nextState, scores] = await Promise.all([
        fetchGridSignals(),
        fetchGridPositions(),
        state.value.sectors.length ? Promise.resolve(state.value) : fetchGridState().catch(() => ({ sectors: [] })),
        fetchGridFitness().catch(() => ({}))
      ])
      signals.value = signalData.signals || []
      if (!strategyCollapseInitialized.value) {
        collapsedStrategyFunds.value = new Set(signals.value.map((signal) => signal.fund_code))
        strategyCollapseInitialized.value = true
      }
      portfolioBudget.value = signalData.portfolio_budget || {}
      positions.value = positionData.funds || {}
      if (Object.keys(scores).length > 0) fitnessScores.value = scores
      resolveStrategyFundNames(signals.value, positions.value)
      regime.value = await fetchMarketRegime().catch(() => ({ regime: 'neutral', auto: true, manual: false }))
      generatedAt.value = signalData.generated_at || ''
      if (!state.value.sectors.length) state.value = nextState
      applyStateStrategyOrder(state.value)
      strategyLoadedAt.value = Date.now()
      lastUpdatedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      writeStrategyCache()
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : '网格信号加载失败'
    } finally {
      loading.value = false
      strategyRefreshing.value = false
      strategyRefreshInFlight = undefined
    }
  })()
  strategyRefreshInFlight = refreshPromise
  return refreshPromise
}

function stopStrategyStream() {
  if (!strategyRefreshTimer) return
  window.clearInterval(strategyRefreshTimer)
  strategyRefreshTimer = undefined
}

function startStrategyStream() {
  if (isValuation.value || strategyRefreshTimer) return
  strategyRefreshTimer = window.setInterval(() => {
    if (document.hidden || strategyRefreshInFlight) return
    void refreshStrategy(true)
  }, strategyRefreshIntervalMs)
}

function stopValuationStream() {
  if (!valuationRefreshTimer) return
  window.clearInterval(valuationRefreshTimer)
  valuationRefreshTimer = undefined
}

function startValuationStream() {
  if (!isValuation.value || valuationRefreshTimer) return
  valuationRefreshTimer = window.setInterval(() => {
    if (document.hidden || valuationRefreshInFlight) return
    void refreshValuations()
  }, valuationRefreshIntervalMs)
}

function stopRefreshStreams() {
  stopStrategyStream()
  stopValuationStream()
}

function startRefreshStream() {
  if (isValuation.value) startValuationStream()
  else startStrategyStream()
}

function rememberValuationFundNames() {
  const names = { ...valuationFundNames.value }
  for (const sector of state.value.sectors) {
    for (const fund of sector.funds) {
      const name = fund.alias || valuations.value[fund.code]?.fund_name
      if (name) names[fund.code] = name
    }
  }
  for (const [code, value] of Object.entries(valuations.value)) {
    if (value.fund_name) names[code] = value.fund_name
  }
  valuationFundNames.value = names
}

function restoreValuationCache() {
  try {
    type ValuationCache = {
      savedAt?: number
      state?: GridState
      valuations?: Record<string, GridValuation>
      fitnessScores?: Record<string, GridFitness>
      fundNames?: Record<string, string>
    }
    const cached = JSON.parse(localStorage.getItem(valuationCacheKey) || 'null') as ValuationCache | null
    const legacy = JSON.parse(localStorage.getItem(legacyValuationCacheKey) || 'null') as ValuationCache | null
    const snapshot = cached?.state && cached.valuations ? cached : legacy
    if (!snapshot?.state || !snapshot.valuations) return 0
    state.value = snapshot.state
    applyStateStrategyOrder(state.value)
    const legacyValuations = legacy?.valuations || {}
    valuations.value = Object.fromEntries(Object.entries(snapshot.valuations).map(([code, value]) => {
      const legacyName = legacyValuations[code]?.fund_name
      return [code, value.fund_name || !legacyName ? value : { ...value, fund_name: legacyName }]
    }))
    fitnessScores.value = snapshot.fitnessScores || {}
    valuationFundNames.value = { ...legacy?.fundNames, ...snapshot.fundNames }
    rememberValuationFundNames()
    if (cached.savedAt) {
      lastUpdatedAt.value = new Date(cached.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    return snapshot.savedAt || 0
  } catch {
    // A malformed cache should never block live data.
    return 0
  }
}

function writeValuationCache() {
  try {
    rememberValuationFundNames()
    localStorage.setItem(valuationCacheKey, JSON.stringify({
      savedAt: Date.now(),
      state: state.value,
      valuations: valuations.value,
      fitnessScores: fitnessScores.value,
      fundNames: valuationFundNames.value
    }))
  } catch {
    // Storage can be unavailable or full in private browsing contexts.
  }
}

function restoreStrategyCache() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(strategyCacheKey) || 'null') as {
      savedAt?: number
      signals?: GridSignal[]
      positions?: Record<string, GridPosition>
      portfolioBudget?: GridPortfolioBudget
      strategyFundNames?: Record<string, string>
      fitnessScores?: Record<string, GridFitness>
      regime?: MarketRegime
      generatedAt?: string
    } | null
    if (!cached?.savedAt || Date.now() - cached.savedAt > 5 * 60 * 1000 || !cached.signals || !cached.positions) return false
    signals.value = cached.signals
    positions.value = cached.positions
    portfolioBudget.value = cached.portfolioBudget || {}
    strategyFundNames.value = cached.strategyFundNames || {}
    if (cached.fitnessScores && Object.keys(cached.fitnessScores).length > 0) {
      fitnessScores.value = cached.fitnessScores
    }
    regime.value = cached.regime || regime.value
    generatedAt.value = cached.generatedAt || ''
    strategyLoadedAt.value = cached.savedAt
    lastUpdatedAt.value = new Date(cached.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    resolveStrategyFundNames(signals.value, positions.value)
    return true
  } catch {
    return false
  }
}

function writeStrategyCache() {
  try {
    sessionStorage.setItem(strategyCacheKey, JSON.stringify({
      savedAt: strategyLoadedAt.value,
      signals: signals.value,
      positions: positions.value,
      portfolioBudget: portfolioBudget.value,
      strategyFundNames: strategyFundNames.value,
      fitnessScores: fitnessScores.value,
      regime: regime.value,
      generatedAt: generatedAt.value
    }))
  } catch {
    // Strategy data remains usable when session storage is unavailable.
  }
}

async function loadPage(force = false) {
  if (isValuation.value) await loadValuation(force)
  else await refreshStrategy(force)
  hasLoaded.value = true
}

async function refreshPage() {
  if (isValuation.value) await refreshValuations()
  else await refreshStrategy(true)
}

async function onPullRefresh() {
  pullRefreshing.value = true
  try {
    await refreshPage()
  } finally {
    pullRefreshing.value = false
  }
}

async function addSector() {
  const name = newSectorName.value.trim()
  if (!name) return
  state.value.sectors.push({ name, funds: [] })
  activeSectorIndex.value = state.value.sectors.length - 1
  newSectorName.value = ''
  addSectorOpen.value = false
  await saveState()
}

async function removeSector(index: number) {
  const sector = state.value.sectors[index]
  if (!sector) return
  try {
    await showConfirmDialog({ title: '删除板块', message: `删除“${sector.name}”及其中基金？` })
    state.value.sectors.splice(index, 1)
    if (!state.value.sectors.length) activeSectorIndex.value = 0
    else if (index < activeSectorIndex.value) activeSectorIndex.value -= 1
    else if (index === activeSectorIndex.value) activeSectorIndex.value = Math.min(index, state.value.sectors.length - 1)
    await saveState()
  } catch {
    // User cancelled the destructive action.
  }
}

async function lookupFundName(index: number) {
  const draft = draftFor(index)
  const code = draft.code.replace(/\D/g, '').slice(0, 6)
  draft.code = code
  if (!/^\d{6}$/.test(code) || draft.alias) return
  draft.lookingUp = true
  try {
    draft.alias = await fetchGridFundName(code)
  } catch {
    // A manual name remains valid when the lookup source is unavailable.
  } finally {
    draft.lookingUp = false
  }
}

async function addFund(index: number) {
  const sector = state.value.sectors[index]
  const draft = draftFor(index)
  const code = draft.code.trim()
  if (!sector || !/^\d{6}$/.test(code)) {
    showToast('请输入 6 位基金代码')
    return
  }
  if (sector.funds.some((fund) => fund.code === code)) {
    showToast('该基金已在当前板块')
    return
  }
  if (!draft.alias) await lookupFundName(index)
  sector.funds.push({ code, alias: draft.alias.trim() })
  draft.code = ''
  draft.alias = ''
  await saveState()
  await refreshValuations()
}

async function removeFund(index: number, code: string) {
  const sector = state.value.sectors[index]
  if (!sector) return
  try {
    await showConfirmDialog({ title: '移除基金', message: `从“${sector.name}”移除 ${code}？` })
    sector.funds = sector.funds.filter((fund) => fund.code !== code)
    await saveState()
  } catch {
    // User cancelled the destructive action.
  }
}

async function openHistory(fund: GridFund) {
  historyOpen.value = true
  historyLoading.value = true
  history.value = []
  historyTitle.value = `${displayName(fund)} (${fund.code})`
  try {
    const data = await fetchGridHistory(fund.code)
    history.value = data.history || []
  } catch (error) {
    showToast(error instanceof Error ? error.message : '历史净值加载失败')
  } finally {
    historyLoading.value = false
  }
}

function actionClass(signal: GridSignal) {
  if (signal.action === 'sell') return 'sell'
  if (signal.action === 'buy') return 'buy'
  return signal.alert ? 'alert' : 'hold'
}

function signalName(row: { code: string; position?: GridPosition }) {
  return row.position?.fund_name || strategyFundNames.value[row.code] || valueFor(row.code).fund_name || valuationFundNames.value[row.code] || row.code
}

function rebuyLabel(signal: GridSignal) {
  if (signal._is_rebuy) return '延迟回补已触发'
  const source = signal.rebuy_recommendation?.source_signal
  return source ? `延迟回补（${source}）` : '延迟回补'
}

function resolveStrategyFundNames(nextSignals: GridSignal[], nextPositions: Record<string, GridPosition>) {
  const codes = [...new Set(nextSignals.map((signal) => signal.fund_code.split('__')[0]))]
  const missing = codes.filter((code) => !strategyFundNames.value[code] && !nextPositions[code]?.fund_name)
  if (!missing.length) return
  void Promise.all(missing.map(async (code) => [code, await fetchGridFundName(code).catch(() => '')] as const)).then((entries) => {
    const resolved = entries.filter(([, name]) => name)
    if (!resolved.length) return
    strategyFundNames.value = { ...strategyFundNames.value, ...Object.fromEntries(resolved) }
    writeStrategyCache()
  })
}

function holdingBatchCount(position?: GridPosition) {
  return position?.batches?.filter((batch) => batch.status === 'holding').length || 0
}

function signalStats(signal: GridSignal) {
  const analysis = signal.market_analysis
  return [
    ['3日', analysis?.short_3d],
    ['5日', analysis?.short_5d],
    ['10日', analysis?.mid_10d],
    ['20日', analysis?.long_20d]
  ].filter(([, value]) => Number.isFinite(value)) as Array<[string, number]>
}

function recentChanges(signal: GridSignal) {
  const byDate = new Map<string, NonNullable<NonNullable<GridSignal['market_analysis']>['day_changes']>[number]>()
  for (const day of signal.market_analysis?.day_changes || []) {
    const date = day.date || ''
    if (date && !byDate.has(date)) byDate.set(date, day)
  }
  return [...byDate.values()]
    .sort((left, right) => (left.date || '').localeCompare(right.date || ''))
    .slice(-10)
}

function barHeight(signal: GridSignal, value?: number | null) {
  const days = recentChanges(signal)
  const max = Math.max(...days.map((day) => Math.abs(Number(day.change) || 0)), 0.5)
  return `${Math.max(4, Math.round(Math.abs(Number(value) || 0) / max * 28))}px`
}

function positionBatches(position?: GridPosition) {
  return [...(position?.batches || [])].filter((batch) => batch.status === 'holding').sort((left, right) => (left.buy_date || '').localeCompare(right.buy_date || ''))
}

function positionCost(position?: GridPosition) {
  return positionBatches(position).reduce((sum, batch) => sum + Number(batch.amount || 0), 0)
}

function positionShares(position?: GridPosition) {
  return positionBatches(position).reduce((sum, batch) => sum + Number(batch.shares || 0), 0)
}

function sellRecords(position?: GridPosition) {
  return [...(position?.sell_records || [])].sort((left, right) =>
    (right.sell_date || '').localeCompare(left.sell_date || '')
  )
}

function strategyParams(signal?: GridSignal | null) {
  return signal?.market_analysis?.strategy_params || {}
}

function openStrategyInfo(signal: GridSignal) {
  strategyInfoSignal.value = signal
  strategyInfoOpen.value = true
}

function applyStrategyMutation(result: GridMutationResult, fallbackKey: string) {
  const key = result.fund_key || fallbackKey
  if (result.position) positions.value = { ...positions.value, [key]: result.position }
  if (result.signal) {
    const next = signals.value.filter((signal) => signal.fund_code !== key)
    next.push(result.signal)
    next.sort((left, right) => (left.priority || 99) - (right.priority || 99))
    signals.value = next
  }
  strategyLoadedAt.value = Date.now()
  writeStrategyCache()
}

async function setRegime(next: 'bull' | 'neutral' | 'bear') {
  try {
    regime.value = await saveMarketRegime(next, true)
    strategyLoadedAt.value = 0
    await refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '行情模式设置失败')
  }
}

async function enableAutoRegime() {
  try {
    // The backend clears the previous decision and recalculates from its
    // source trend data when the following signal refresh runs.
    regime.value = await saveMarketRegime('neutral', false)
    strategyLoadedAt.value = 0
    await refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '自动行情模式设置失败')
  }
}

function openPositionEditor(fundKey = '') {
  const { code, owner } = splitPositionKey(fundKey)
  positionForm.code = code
  positionForm.importedHoldingCode = ''
  positionOwner.value = owner
  positionForm.buyRows.splice(0, positionForm.buyRows.length, { amount: '', buyDate: todayString() })
  positionForm.nav = ''
  positionForm.note = ''
  positionForm.isRebuy = false
  positionForm.pendingRebuyId = ''
  positionForm.maxPosition = fundKey && positions.value[fundKey]?.max_position
    ? String(positions.value[fundKey].max_position)
    : '5000'
  positionEditorOpen.value = true
}

const importableHoldings = computed(() => holdingStore.holdings.filter((holding) => /^\d{6}$/.test(holding.code)))

function importExistingHolding(code: string) {
  positionForm.importedHoldingCode = code
  if (!code) {
    positionForm.code = ''
    return
  }
  const holding = importableHoldings.value.find((item) => item.code === code)
  if (!holding) return
  positionForm.code = holding.code
  positionForm.buyRows.splice(0, positionForm.buyRows.length, {
    amount: Number(holding.amount || 0).toFixed(2),
    buyDate: holding.buyDate || todayString()
  })
  const costNav = Number(holding.costUnitPrice || holding.costPrice || holding.buyNetValue || 0)
  positionForm.nav = costNav > 0 ? costNav.toFixed(4) : ''
  positionForm.note = '导入自现有持仓'
  positionForm.maxPosition = String(Math.max(5000, Math.ceil(Number(holding.amount || 0) / 100) * 100))
}

function addBuyRow() {
  positionForm.buyRows.push({ amount: '', buyDate: todayString() })
}

function removeBuyRow(index: number) {
  if (positionForm.buyRows.length === 1) {
    positionForm.buyRows[0] = { amount: '', buyDate: todayString() }
    return
  }
  positionForm.buyRows.splice(index, 1)
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

function triggerTradeImageImport() {
  if (!/^\d{6}$/.test(normalizedPositionCode())) {
    showToast('请先选择或输入 6 位基金代码')
    return
  }
  tradeImageInput.value?.click()
}

function tradeImportRowKey(item: GridTradeOcrItem) {
  return [item.type, item.operation, item.date, item.time, item.amount, item.shares, item.source_fund_code, item.target_fund_code, item.description].join('|')
}

function currentTradeImportFundName(code: string) {
  const owner = positionOwner.value
  const key = owner ? `${code}__${owner}` : code
  return positions.value[key]?.fund_name
    || positions.value[code]?.fund_name
    || importableHoldings.value.find((holding) => holding.code === code)?.name
    || strategyFundNames.value[code]
    || valuationFundNames.value[code]
    || valueFor(code).fund_name
    || ''
}

function isConversionTransferIn(row: TradeImportRow) {
  return row.operation === 'conversion' && row.type === 'buy'
}

function historyFor(code: string) {
  return tradeImportHistory.value[code] || {}
}

function recalculateTradeImportRow(row: TradeImportRow, source: 'nav' | 'amount' | 'shares' | 'sourceNav') {
  const nav = Number(row.nav)
  const amount = Number(row.amount)
  const shares = Number(row.shares)
  const sourceShares = Number(row.sourceShares)
  const sourceNav = Number(row.sourceNav)

  const conversion = isConversionTransferIn(row)
    ? calculateGridConversionTransferIn(sourceShares, sourceNav, nav)
    : null
  if (conversion) {
    row.amount = conversion.amount.toFixed(2)
    row.shares = conversion.targetShares.toFixed(2)
    return
  }

  if (!Number.isFinite(nav) || nav <= 0) return

  const shouldUseShares = source === 'shares'
    || (source === 'nav' && row.type === 'sell' && Number.isFinite(shares) && shares > 0)
    || (source === 'nav' && (!Number.isFinite(amount) || amount <= 0) && Number.isFinite(shares) && shares > 0)
  if (shouldUseShares && Number.isFinite(shares) && shares > 0) {
    row.amount = (shares * nav).toFixed(2)
  } else if (Number.isFinite(amount) && amount > 0) {
    row.shares = (amount / nav).toFixed(2)
  }
}

function applyTradeImportNav(row: TradeImportRow) {
  const currentCode = normalizedPositionCode()
  const currentHistory = historyFor(currentCode)
  row.navDate = resolveGridTradeConfirmationDate(row.date, row.time, Object.keys(currentHistory))
  const nav = currentHistory[row.navDate]
  row.nav = Number.isFinite(nav) && nav > 0 ? nav.toFixed(4) : ''

  const sourceCode = row.source_fund_code || (row.type === 'sell' ? currentCode : '')
  const sourceHistory = historyFor(sourceCode)
  row.sourceNavDate = sourceCode
    ? resolveGridTradeConfirmationDate(row.date, row.time, Object.keys(sourceHistory))
    : row.navDate
  const sourceNav = sourceHistory[row.sourceNavDate]
  row.sourceNav = Number.isFinite(sourceNav) && sourceNav > 0 ? sourceNav.toFixed(4) : ''
  recalculateTradeImportRow(row, 'nav')
}

function applySelectedTradeImportNav(row: TradeImportRow) {
  const nav = historyFor(normalizedPositionCode())[row.navDate]
  if (Number.isFinite(nav) && nav > 0) row.nav = nav.toFixed(4)
  recalculateTradeImportRow(row, 'nav')
}

async function hydrateTradeImportNavs(code: string) {
  const timestamps = tradeImportRows.value.map((row) => Date.parse(`${row.date}T00:00:00Z`)).filter(Number.isFinite)
  const oldest = timestamps.length ? Math.min(...timestamps) : Date.now()
  const calendarDays = Math.max(0, Math.ceil((Date.now() - oldest) / 86_400_000))
  const historyDays = Math.min(2000, Math.max(60, calendarDays + 30))
  const codes = [...new Set([
    code,
    ...tradeImportRows.value
      .filter(isConversionTransferIn)
      .map((row) => row.source_fund_code || '')
      .filter((sourceCode) => /^\d{6}$/.test(sourceCode))
  ])]
  const entries = await Promise.all(codes.map(async (fundCode) => {
    const result = await fetchGridHistory(fundCode, historyDays).catch(() => ({ history: [] }))
    return [fundCode, Object.fromEntries(
      (result.history || [])
        .filter((item) => item.date && Number.isFinite(item.nav) && Number(item.nav) > 0)
        .map((item) => [String(item.date), Number(item.nav)])
    )] as const
  }))
  tradeImportHistory.value = Object.fromEntries(entries)
  if (!Object.keys(historyFor(code)).length) throw new Error(`未加载到基金 ${code} 的历史净值`)
  tradeImportRows.value.forEach(applyTradeImportNav)
}

async function handleTradeImages(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files || [])]
  input.value = ''
  if (!files.length) return

  const supported = files.filter((file) => /image\/(png|jpe?g|webp)/i.test(file.type) && file.size > 0 && file.size <= 8 * 1024 * 1024)
  if (supported.length !== files.length) {
    showToast('仅支持 8 MB 以内的 PNG、JPEG 或 WebP 图片')
    if (!supported.length) return
  }

  const code = normalizedPositionCode()
  tradeImportOpen.value = true
  tradeImportRecognizing.value = true
  tradeImportSaving.value = false
  tradeImportRows.value = []
  tradeImportHistory.value = {}
  tradeImportFundName.value = ''
  const fundNames = new Set<string>()
  const seen = new Set<string>()
  const errors: string[] = []

  try {
    for (let imageIndex = 0; imageIndex < supported.length; imageIndex++) {
      tradeImportStatus.value = `正在识别第 ${imageIndex + 1}/${supported.length} 张图片`
      try {
        const result = await recognizeGridTrades(await fileToDataUrl(supported[imageIndex]))
        if (result.fund_name) fundNames.add(result.fund_name)
        for (const [rowIndex, item] of (result.items || []).entries()) {
          const key = tradeImportRowKey(item)
          if (seen.has(key)) continue
          seen.add(key)
          const type = resolveGridTradeDirection(item, code, currentTradeImportFundName(code), result.fund_name || '')
          const conversionTransferIn = item.operation === 'conversion' && type === 'buy'
          tradeImportRows.value.push({
            ...item,
            type,
            id: `${Date.now()}-${imageIndex}-${rowIndex}`,
            included: true,
            amount: String(item.amount || ''),
            shares: conversionTransferIn ? '' : String(item.shares || ''),
            nav: '',
            navDate: '',
            sourceShares: conversionTransferIn ? String(item.source_shares || item.shares || '') : '',
            sourceNav: '',
            sourceNavDate: '',
            screenshotFundName: result.fund_name || '',
            screenshotFundCode: result.fund_code || '',
            status: 'pending'
          })
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `第 ${imageIndex + 1} 张识别失败`)
      }
    }

    tradeImportFundName.value = [...fundNames].join(' / ')
    if (!tradeImportRows.value.length) {
      tradeImportStatus.value = errors[0] || '没有识别到买入或卖出流水'
      return
    }

    tradeImportStatus.value = '正在匹配交易日净值'
    try {
      await hydrateTradeImportNavs(code)
      const missing = tradeImportRows.value.filter((row) => !isTradeImportRowReady(row)).length
      tradeImportStatus.value = missing
        ? `已识别 ${tradeImportRows.value.length} 笔，${missing} 笔确认净值待补充`
        : `已识别 ${tradeImportRows.value.length} 笔并按 15:00 规则匹配确认净值`
    } catch (error) {
      tradeImportStatus.value = `已识别 ${tradeImportRows.value.length} 笔，历史净值加载失败，请手动补充`
      errors.push(error instanceof Error ? error.message : '历史净值加载失败')
    }
    if (errors.length) showToast(`${errors.length} 张图片处理失败，其余结果已保留`)
  } finally {
    tradeImportRecognizing.value = false
  }
}

function isTradeImportRowReady(row: TradeImportRow) {
  const nav = Number(row.nav)
  const amount = Number(row.amount)
  const shares = Number(row.shares)
  const conversionReady = !isConversionTransferIn(row)
    || (Number.isFinite(Number(row.sourceShares)) && Number(row.sourceShares) > 0
      && Number.isFinite(Number(row.sourceNav)) && Number(row.sourceNav) > 0)
  return isValidBuyDate(row.date) && isValidBuyDate(row.navDate)
    && Number.isFinite(nav) && nav > 0
    && Number.isFinite(amount) && amount > 0
    && Number.isFinite(shares) && shares > 0
    && conversionReady
}

function selectedTradeImportRows() {
  return tradeImportRows.value.filter((row) => row.included && row.status !== 'imported')
}

async function importRecognizedTrades() {
  const code = normalizedPositionCode()
  const owner = positionOwner.value
  const fundKey = owner ? `${code}__${owner}` : code
  const selected = selectedTradeImportRows()
  if (!selected.length) return showToast('请至少选择一笔待导入流水')
  if (selected.some((row) => !isTradeImportRowReady(row))) return showToast('请补全所选流水的日期、金额、份额和净值')

  const ordered = [...selected].sort((left, right) => {
    const timeOrder = `${left.navDate} ${left.date} ${left.time || '00:00:00'}`.localeCompare(`${right.navDate} ${right.date} ${right.time || '00:00:00'}`)
    return timeOrder || (left.type === right.type ? 0 : left.type === 'buy' ? -1 : 1)
  })

  let latestPosition: GridPosition | null = null
  try {
    latestPosition = await fetchGridPosition(fundKey)
  } catch {
    latestPosition = positions.value[fundKey] || null
  }
  let projectedShares = positionShares(latestPosition || undefined)
  for (const row of ordered) {
    if (row.type === 'buy') projectedShares += Number(row.shares)
    else {
      if (Number(row.shares) > projectedShares + 0.01) {
        return showToast(`${row.date} 卖出 ${Number(row.shares).toFixed(2)} 份超过此前累计持仓`)
      }
      projectedShares -= Number(row.shares)
    }
  }

  const maxPosition = Number(positionForm.maxPosition)
  if (!Number.isFinite(maxPosition) || maxPosition <= 0) return showToast('请输入有效持仓上限')
  tradeImportSaving.value = true
  let importedCount = 0
  try {
    await updateGridPositionConfig(fundKey, { max_position: maxPosition })
    for (const row of ordered) {
      row.status = 'pending'
      const orderTime = `${row.date}${row.time ? ` ${row.time}` : ''}`
      const noteParts = [
        `图片导入${row.description ? `：${row.description}` : ''}`,
        `原始下单 ${orderTime}`,
        `确认净值日 ${row.navDate}`
      ]
      if (isConversionTransferIn(row)) {
        noteParts.push(`转换来源 ${row.source_fund_code || row.source_fund_name || '未知'} ${Number(row.sourceShares).toFixed(2)}份×${Number(row.sourceNav).toFixed(4)}`)
      }
      const note = noteParts.join('；')
      try {
        const result = row.type === 'buy'
          ? await createGridBuy(code, {
              amount: Number(row.amount), nav: Number(row.nav), note, buy_date: row.navDate, owner
            })
          : await sellGridPositionFifo(fundKey, {
              total_sell_shares: Number(row.shares), sell_nav: Number(row.nav), sell_date: row.navDate
            })
        applyStrategyMutation(result, fundKey)
        row.status = 'imported'
        row.included = false
        importedCount++
      } catch (error) {
        row.status = 'failed'
        throw error
      }
    }

    tradeImportOpen.value = false
    positionEditorOpen.value = false
    showToast(`已导入 ${importedCount} 笔买卖流水`)
  } catch (error) {
    const prefix = importedCount ? `已成功 ${importedCount} 笔；` : ''
    showToast(`${prefix}${error instanceof Error ? error.message : '导入失败'}`)
  } finally {
    tradeImportSaving.value = false
    void refreshStrategy(true)
  }
}

function isValidBuyDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const date = new Date(`${value}T00:00:00`)
  return !Number.isNaN(date.getTime())
    && date.getFullYear() === Number(match[1])
    && date.getMonth() + 1 === Number(match[2])
    && date.getDate() === Number(match[3])
}

function getBuyRows() {
  const entered = positionForm.buyRows.filter((row) => row.amount.trim())
  return entered.map((row) => {
    const amount = Number(row.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('每笔买入金额必须大于 0')
    if (!isValidBuyDate(row.buyDate)) {
      throw new Error('每笔买入都必须填写有效日期')
    }
    return { amount, buyDate: row.buyDate }
  })
}

function normalizedPositionCode() {
  if (positionForm.importedHoldingCode) {
    return positionForm.importedHoldingCode.replace(/\D/g, '').slice(0, 6)
  }
  return positionForm.code.replace(/\D/g, '').slice(0, 6)
}

async function savePosition() {
  const code = normalizedPositionCode()
  const owner = positionOwner.value
  const maxPosition = Number(positionForm.maxPosition)
  const nav = positionForm.nav.trim() ? Number(positionForm.nav) : undefined
  if (!/^\d{6}$/.test(code)) return showToast('请输入 6 位基金代码')
  if (!Number.isFinite(maxPosition) || maxPosition <= 0) return showToast('请输入有效持仓上限')
  if (nav !== undefined && (!Number.isFinite(nav) || nav <= 0)) return showToast('确认净值必须大于 0')
  let buyRows: Array<{ amount: number; buyDate: string }>
  try {
    buyRows = getBuyRows()
  } catch (error) {
    return showToast(error instanceof Error ? error.message : '请输入有效买入金额')
  }
  if (positionForm.isRebuy && buyRows.length > 1) return showToast('延迟回补只能录入一笔买入金额')
  positionSaving.value = true
  try {
    const fundKey = owner ? `${code}__${owner}` : code
    if (buyRows.length) {
      await updateGridPositionConfig(fundKey, { max_position: maxPosition })
      for (const row of buyRows) {
        const result = await createGridBuy(code, {
          amount: row.amount, nav, note: positionForm.note.trim(), buy_date: row.buyDate, owner,
          is_rebuy: positionForm.isRebuy, pending_rebuy_id: positionForm.pendingRebuyId || undefined
        })
        applyStrategyMutation(result, fundKey)
      }
      showToast(buyRows.length > 1 ? `已录入 ${buyRows.length} 笔买入批次` : '买入已录入')
    } else {
      const result = await createGridWatch(code, { max_position: maxPosition, note: positionForm.note.trim(), owner })
      applyStrategyMutation(result, fundKey)
      showToast('已加入空仓观察')
    }
    positionEditorOpen.value = false
    void refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '保存持仓失败')
  } finally {
    positionSaving.value = false
  }
}

async function openSellEditor(fundKey: string, position?: GridPosition, suggestedShares?: number | null) {
  activePositionKey.value = fundKey
  try {
    activePosition.value = await fetchGridPosition(fundKey)
  } catch {
    activePosition.value = position || null
  }
  const totalShares = activePosition.value?.batches
    ?.filter((batch) => batch.status === 'holding')
    .reduce((sum, batch) => sum + Number(batch.shares || 0), 0) || 0
  sellForm.shares = suggestedShares && suggestedShares > 0 ? suggestedShares.toFixed(2) : ''
  sellForm.nav = ''
  sellForm.sellDate = todayString()
  if (!totalShares) showToast('当前没有可卖出的持仓份额')
  else sellEditorOpen.value = true
}

function availableShares() {
  return activePosition.value?.batches
    ?.filter((batch) => batch.status === 'holding')
    .reduce((sum, batch) => sum + Number(batch.shares || 0), 0) || 0
}

async function saveSell() {
  const shares = Number(sellForm.shares)
  const nav = sellForm.nav.trim() ? Number(sellForm.nav) : undefined
  if (!Number.isFinite(shares) || shares <= 0) return showToast('请输入有效卖出份额')
  if (shares > availableShares() + 0.001) return showToast('卖出份额不能超过当前持仓')
  if (nav !== undefined && (!Number.isFinite(nav) || nav <= 0)) return showToast('确认净值必须大于 0')
  sellSaving.value = true
  try {
    const result = await sellGridPositionFifo(activePositionKey.value, { total_sell_shares: shares, sell_nav: nav, sell_date: sellForm.sellDate })
    applyStrategyMutation(result, activePositionKey.value)
    sellEditorOpen.value = false
    showToast('FIFO 卖出已录入')
    void refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '卖出失败')
  } finally {
    sellSaving.value = false
  }
}

function openRebuy(row: { signal: GridSignal; code: string }) {
  const recommendation = row.signal.rebuy_recommendation
  const signal = row.signal.all_signals?.find((item) => item._is_rebuy && item._pending_rebuy_id) || row.signal
  openPositionEditor(row.signal.fund_code)
  positionForm.buyRows.splice(0, positionForm.buyRows.length, {
    amount: Number(signal.amount || recommendation?.amount || 0).toFixed(2),
    buyDate: todayString()
  })
  positionForm.note = signal.reason || recommendation?.reason || '延迟回补'
  positionForm.isRebuy = true
  positionForm.pendingRebuyId = signal._pending_rebuy_id || recommendation?.pending_rebuy_id || ''
}

function holdingDays(date?: string) {
  if (!date) return '--'
  const startedAt = new Date(`${date}T00:00:00`).getTime()
  if (!Number.isFinite(startedAt)) return '--'
  return Math.max(0, Math.floor((Date.now() - startedAt) / 86_400_000))
}

async function openBatchSell(fundKey: string, batch: { id?: string; shares?: number; amount?: number; nav?: number | null; buy_date?: string; note?: string }) {
  if (!batch.id) return
  activePositionKey.value = fundKey
  let latest = batch
  try {
    const position = await fetchGridPosition(fundKey)
    latest = position.batches?.find((item) => item.id === batch.id && item.status === 'holding') || batch
  } catch {
    // The visible position remains a usable fallback if the detail refresh fails.
  }
  const shares = Number(latest.shares || 0)
  if (!shares) return showToast('该批次没有可卖份额')
  activeBatch.value = {
    id: latest.id || batch.id,
    shares,
    amount: latest.amount,
    nav: latest.nav,
    buyDate: latest.buy_date,
    note: latest.note
  }
  batchSellForm.shares = shares.toFixed(2)
  batchSellForm.nav = ''
  batchSellForm.sellDate = todayString()
  batchSellOpen.value = true
}

async function saveBatchSell() {
  const batch = activeBatch.value
  const shares = Number(batchSellForm.shares)
  const nav = batchSellForm.nav.trim() ? Number(batchSellForm.nav) : undefined
  if (!batch || !Number.isFinite(shares) || shares <= 0 || shares > batch.shares + 0.001) return showToast('请输入不超过该批次的有效份额')
  if (nav !== undefined && (!Number.isFinite(nav) || nav <= 0)) return showToast('确认净值必须大于 0')
  batchSellSaving.value = true
  try {
    const result = await sellGridBatch(activePositionKey.value, { batch_id: batch.id, sell_shares: shares, sell_nav: nav, sell_date: batchSellForm.sellDate })
    applyStrategyMutation(result, activePositionKey.value)
    batchSellOpen.value = false
    showToast('该批次卖出已录入')
    void refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '卖出失败')
  } finally {
    batchSellSaving.value = false
  }
}

function openBuyNavEditor(fundKey: string, batch: GridBatch) {
  if (!batch.id) return
  buyNavTarget.value = {
    fundKey,
    batchId: batch.id,
    buyDate: batch.buy_date,
    amount: batch.amount,
    currentNav: batch.nav
  }
  buyNavForm.value = Number(batch.nav) > 0 ? Number(batch.nav).toFixed(4) : ''
  buyNavEditorOpen.value = true
}

async function saveBuyNav() {
  const target = buyNavTarget.value
  const nav = Number(buyNavForm.value)
  if (!target) return
  if (!Number.isFinite(nav) || nav <= 0) return showToast('请输入大于 0 的确认净值')
  buyNavSaving.value = true
  try {
    const result = await updateGridBuyNav(target.fundKey, target.batchId, nav)
    applyStrategyMutation(result, target.fundKey)
    buyNavEditorOpen.value = false
    showToast(target.currentNav ? '买入净值已修改' : '买入净值已补录')
    void refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '净值保存失败')
  } finally {
    buyNavSaving.value = false
  }
}

async function fillSellNav(fundKey: string, sellRecordId?: string) {
  if (!sellRecordId) return
  const value = window.prompt('请输入卖出确认净值（在支付宝->交易记录->卖出详情中查看）')
  const nav = Number(value)
  if (!Number.isFinite(nav) || nav <= 0) return
  try {
    const result = await updateGridSellNav(fundKey, sellRecordId, nav)
    applyStrategyMutation(result, fundKey)
    showToast('卖出净值已补录')
    void refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '补录失败')
  }
}

async function deleteBatch(fundKey: string, batchId?: string) {
  if (!batchId) return
  try {
    await showConfirmDialog({ title: '删除批次', message: `确定删除批次 ${batchId}？关联卖出记录也会删除。` })
    const result = await deleteGridBatch(fundKey, batchId)
    applyStrategyMutation(result, fundKey)
    showToast('批次已删除')
    void refreshStrategy(true)
  } catch (error) {
    if (error instanceof Error && error.message !== 'cancel') showToast(error.message)
  }
}

async function deleteSellRecord(fundKey: string, recordId?: string) {
  if (!recordId) return
  try {
    await showConfirmDialog({ title: '删除卖出记录', message: `确定删除卖出记录 ${recordId}？` })
    const result = await deleteGridSellRecord(fundKey, recordId)
    applyStrategyMutation(result, fundKey)
    showToast('卖出记录已删除')
    void refreshStrategy(true)
  } catch (error) {
    if (error instanceof Error && error.message !== 'cancel') showToast(error.message)
  }
}

function openSettings(fundKey: string, position?: GridPosition) {
  activePositionKey.value = fundKey
  activePosition.value = position || positions.value[fundKey] || null
  settingsOpen.value = true
}

function openMaxPositionEditor(fundKey: string, position?: GridPosition) {
  activePositionKey.value = fundKey
  activePosition.value = position || positions.value[fundKey] || null
  maxPositionForm.value = String(activePosition.value?.max_position || 5000)
  settingsOpen.value = false
  maxPositionEditorOpen.value = true
}

function openFeeScheduleEditor(fundKey: string, position?: GridPosition) {
  activePositionKey.value = fundKey
  activePosition.value = position || positions.value[fundKey] || null
  feeScheduleForm.value = formatFeeSchedule(activePosition.value?.fee_schedule)
  settingsOpen.value = false
  feeScheduleEditorOpen.value = true
}

async function openVolSensitivityEditor(fundKey: string, position?: GridPosition) {
  activePositionKey.value = fundKey
  activePosition.value = position || positions.value[fundKey] || null
  volSensitivityEditorOpen.value = true
  volSensitivityLoading.value = true
  try {
    volSensitivity.value = await fetchGridVolSensitivity(fundKey)
    volSensitivityValue.value = Number(volSensitivity.value.effective) || 1
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载参数灵敏度失败')
  } finally {
    volSensitivityLoading.value = false
  }
}

async function saveVolSensitivity() {
  const sensitivity = Number(volSensitivityValue.value)
  if (!Number.isFinite(sensitivity) || sensitivity < 0.5 || sensitivity > 1.5) return showToast('灵敏度范围为 0.5 至 1.5')
  parameterSaving.value = true
  try {
    await updateGridVolSensitivity(activePositionKey.value, sensitivity)
    volSensitivityEditorOpen.value = false
    showToast('参数灵敏度已更新')
    await refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '更新参数灵敏度失败')
  } finally {
    parameterSaving.value = false
  }
}

async function resetVolSensitivity() {
  parameterSaving.value = true
  try {
    await clearGridVolSensitivity(activePositionKey.value)
    volSensitivity.value = await fetchGridVolSensitivity(activePositionKey.value)
    volSensitivityValue.value = Number(volSensitivity.value.effective) || 1
    showToast('已恢复自动校准')
    await refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '恢复自动校准失败')
  } finally {
    parameterSaving.value = false
  }
}

async function recalibrateVolSensitivity() {
  parameterSaving.value = true
  try {
    volSensitivity.value = await recalibrateGridVolSensitivity(activePositionKey.value)
    volSensitivityValue.value = Number(volSensitivity.value.effective) || 1
    showToast('参数灵敏度已重新校准')
    await refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '重新校准失败')
  } finally {
    parameterSaving.value = false
  }
}

async function saveMaxPosition() {
  const maxPosition = Number(maxPositionForm.value)
  if (!Number.isFinite(maxPosition) || maxPosition <= 0) return showToast('请输入有效持仓上限')
  parameterSaving.value = true
  try {
    await updateGridPositionConfig(activePositionKey.value, { max_position: maxPosition })
    maxPositionEditorOpen.value = false
    showToast('持仓上限已更新')
    await refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '更新持仓上限失败')
  } finally {
    parameterSaving.value = false
  }
}

async function saveFeeSchedule() {
  let schedule: GridFeeScheduleItem[]
  try {
    schedule = parseFeeSchedule(feeScheduleForm.value)
  } catch (error) {
    return showToast(error instanceof Error ? error.message : '费率格式错误')
  }
  parameterSaving.value = true
  try {
    await updateGridFeeSchedule(activePositionKey.value, schedule)
    feeScheduleEditorOpen.value = false
    showToast('卖出费率已更新')
    await refreshStrategy(true)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '更新卖出费率失败')
  } finally {
    parameterSaving.value = false
  }
}

async function deletePosition(fundKey: string) {
  try {
    await showConfirmDialog({ title: '移除基金', message: `确定从低频网格移除 ${fundKey}？此操作会删除全部批次。` })
    await removeGridPosition(fundKey)
    showToast('已移除')
    await refreshStrategy(true)
  } catch (error) {
    // Vant rejects the confirmation promise when the user cancels.
    if (error instanceof Error && error.message !== 'cancel') showToast(error.message)
  }
}

function goToStrategy() {
  router.push('/low-frequency-grid')
}

watch(() => props.mode, async () => {
  hasLoaded.value = false
  stopRefreshStreams()
  destroyStrategySortable()
  await loadPage()
  await setupStrategySortable()
  startRefreshStream()
})
onMounted(async () => {
  await Promise.all([holdingStore.initHoldings(), loadPage()])
  await setupStrategySortable()
  startRefreshStream()
})
onActivated(() => {
  if (!hasLoaded.value) void loadPage()
  void setupStrategySortable()
  startRefreshStream()
})
onDeactivated(() => {
  stopRefreshStreams()
  destroyStrategySortable()
})
onBeforeUnmount(() => {
  stopRefreshStreams()
  destroyStrategySortable()
})
</script>

<template>
  <main class="grid-native-page" :class="{ 'strategy-source-page': !isValuation }">
    <input ref="tradeImageInput" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" multiple @change="handleTradeImages">
    <van-pull-refresh v-model="pullRefreshing" class="grid-pull-refresh" @refresh="onPullRefresh">
      <header class="grid-header">
      <div class="grid-heading">
        <span class="grid-eyebrow">基金宝</span>
        <h1>{{ pageTitle }}</h1>
      </div>
      <div class="grid-header-actions">
        <span class="update-status">{{ lastUpdatedAt ? `更新 ${lastUpdatedAt}` : '准备加载' }}</span>
        <button class="icon-button" type="button" :disabled="loading || isPageRefreshing" title="刷新数据" @click="refreshPage">
          <van-icon name="replay" :class="{ spinning: loading || isPageRefreshing }" />
        </button>
      </div>
      </header>

    <section v-if="isValuation" class="valuation-workspace">
      <div class="valuation-toolbar">
        <div>
          <h2>板块估值</h2>
          <p>实时涨跌、阶段表现与置信度</p>
        </div>
        <button class="command-button" type="button" @click="addSectorOpen = true">
          <van-icon name="plus" /> 新建板块
        </button>
      </div>

      <p v-if="loadError" class="load-error">{{ loadError }}</p>
      <div v-if="loading && !state.sectors.length" class="loading-state"><van-loading size="20" /> 正在加载估值数据</div>
      <div v-else-if="!state.sectors.length" class="empty-state">
        <van-icon name="apps-o" size="38" />
        <p>暂无估值板块</p>
        <button class="command-button" type="button" @click="addSectorOpen = true">创建第一个板块</button>
      </div>

      <template v-if="activeSector">
        <div class="sector-tab-scroll" role="tablist" aria-label="估值板块">
          <button
            v-for="{ sector, index } in sortedSectors"
            :key="`${sector.name}-${index}`"
            class="sector-tab"
            :class="{ active: activeSectorIndex === index }"
            type="button"
            role="tab"
            :aria-selected="activeSectorIndex === index"
            @click="activeSectorIndex = index"
          >
            <span>{{ sector.name }}</span>
            <small>{{ sector.funds.length }} 只</small>
          </button>
        </div>

        <section :key="`${activeSector.sector.name}-${activeSector.index}`" class="sector-panel" role="tabpanel">
          <div class="sector-panel-header">
            <div class="sector-panel-title">
              <span>{{ activeSector.sector.name }}</span>
              <small>{{ activeSector.sector.funds.length }} 只基金</small>
            </div>
            <div class="sector-actions">
              <button class="icon-button danger" type="button" title="删除板块" @click="removeSector(activeSector.index)"><van-icon name="delete-o" /></button>
            </div>
          </div>

          <div v-if="activeSector.funds.length" class="valuation-table-scroll">
            <table class="valuation-table">
              <thead>
                <tr>
                  <th>代码/简称</th>
                  <th>基金名称</th>
                  <th>实时估值</th>
                  <th><button class="table-help" type="button" @click="openExplanation('confidence')">置信度 <van-icon name="question-o" /></button></th>
                  <th><button class="table-help" type="button" @click="openExplanation('fitness')">基金适配评分 <van-icon name="question-o" /></button></th>
                  <th>近 5 日</th>
                  <th>近 20 日</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="fund in activeSector.funds" :key="fund.code">
                  <td class="fund-cell">
                    <div class="fund-identity">
                      <button class="fund-code" type="button" @click="openHistory(fund)">{{ fund.code }}</button>
                      <span class="fund-name" :title="displayName(fund)">
                        <a class="fund-name-deep-link" :href="getJdFundLink(fund.code)" @click.stop>{{ displayName(fund).slice(0, 4) }}</a>
                      </span>
                    </div>
                  </td>
                  <td class="fund-name-full">
                    <button type="button" :title="displayName(fund)" @click="goToFundDetail(fund.code)">{{ displayName(fund) }}</button>
                  </td>
                  <td :class="['numeric', changeClass(valueFor(fund.code).estimation_change)]">{{ formatPercent(valueFor(fund.code).estimation_change) }}</td>
                  <td class="numeric confidence">{{ confidence(valueFor(fund.code)) }}</td>
                  <td class="numeric"><span v-if="scoreFor(fund.code) !== null" class="fitness" :class="scoreClass(fund.code)">{{ scoreFor(fund.code) }}</span><span v-else>--</span></td>
                  <td :class="['numeric', changeClass(valueFor(fund.code).week_change)]">{{ formatPercent(valueFor(fund.code).week_change) }}</td>
                  <td :class="['numeric', changeClass(valueFor(fund.code).month_change)]">{{ formatPercent(valueFor(fund.code).month_change) }}</td>
                  <td class="row-actions">
                    <button class="icon-button quiet" type="button" title="查看历史净值" @click="openHistory(fund)"><van-icon name="chart-trending-o" /></button>
                    <button class="icon-button quiet" type="button" title="查看网格信号" @click="goToStrategy"><van-icon name="apps-o" /></button>
                    <button class="icon-button danger" type="button" title="从板块移除" @click="removeFund(activeSector.index, fund.code)"><van-icon name="cross" /></button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="sector-empty">该板块暂无基金</p>

          <div class="fund-adder">
            <input v-model="draftFor(activeSector.index).code" inputmode="numeric" maxlength="6" placeholder="6 位代码" @input="lookupFundName(activeSector.index)" @keyup.enter="addFund(activeSector.index)">
            <input v-model="draftFor(activeSector.index).alias" :placeholder="draftFor(activeSector.index).lookingUp ? '查询名称中...' : '基金名称（可选）'" @keyup.enter="addFund(activeSector.index)">
            <button class="command-button" type="button" @click="addFund(activeSector.index)">添加</button>
          </div>
        </section>
      </template>
    </section>

    <section v-else class="strategy-workspace source-grid-workspace">
      <div class="strategy-toolbar">
        <div>
          <h2>低频网格</h2>
          <p>{{ generatedAt ? `信号生成于 ${generatedAt}` : '策略信号与持仓状态' }}</p>
        </div>
        <div class="strategy-commands">
          <button class="command-button" type="button" @click="openPositionEditor()"><van-icon name="plus" /> 录入持仓</button>
        </div>
      </div>

      <div v-if="portfolioBudget.max_invest" class="budget-strip">
        <span>预算</span>
        <div class="budget-track"><i :style="{ width: `${budgetPercent}%` }"></i></div>
        <span>{{ formatMoney(portfolioBudget.invested, 0) }} / {{ formatMoney(portfolioBudget.max_invest, 0) }}</span>
        <span>可用 <b>{{ formatMoney(budgetAvailable, 0) }}</b></span>
      </div>

      <div class="regime-strip">
        <span>行情模式</span>
        <button type="button" :class="{ active: !regime.manual }" @click="enableAutoRegime">自动</button>
        <button type="button" :class="{ active: regime.manual && regime.regime === 'bull' }" @click="setRegime('bull')">🐂 牛市</button>
        <button type="button" :class="{ active: regime.manual && regime.regime !== 'bear' }" @click="setRegime('neutral')">震荡</button>
        <button type="button" :class="{ active: regime.manual && regime.regime === 'bear' }" @click="setRegime('bear')">🐻 熊市</button>
        <small>{{ regime.manual ? `手动 · ${regimeIcon(regime.manual_regime || regime.regime)} ${regimeLabel(regime.manual_regime || regime.regime)}` : `自动识别 · ${regimeIcon(regime.auto_result || regime.regime)} ${regimeLabel(regime.auto_result || regime.regime)}` }}{{ !regime.manual && regime.auto_at ? ` · ${regime.auto_at}` : '' }}</small>
      </div>

      <p v-if="loadError" class="load-error">{{ loadError }}</p>
      <div v-if="loading && !strategyRows.length" class="loading-state"><van-loading size="20" /> 正在加载策略信号</div>
      <div v-else-if="!strategyRows.length" class="empty-state">
        <van-icon name="apps-o" size="38" />
        <p>暂无网格信号</p>
        <span>可先在实时估值中观察基金</span>
      </div>

      <div ref="strategyListRef" class="strategy-card-list">
      <article
        v-for="row in strategyRows"
        :key="row.signal.fund_code"
        class="signal-card"
        :class="collapsedStrategyFunds.has(row.signal.fund_code) ? 'signal-card-collapsed' : 'signal-card-expanded'"
        :data-fund-key="row.signal.fund_code"
      >
        <header class="signal-header">
          <div class="signal-title-group">
            <button class="strategy-title" type="button" :title="collapsedStrategyFunds.has(row.signal.fund_code) ? '展开基金策略' : '收起基金策略'" @click="toggleStrategyFund(row.signal.fund_code)">
              <van-icon :name="collapsedStrategyFunds.has(row.signal.fund_code) ? 'arrow' : 'arrow-down'" />
            </button>
            <a class="strategy-code" :href="getJdFundLink(row.code)" @click.stop>{{ row.code }}</a>
            <button class="strategy-fund-name" type="button" :title="signalName(row)" @click="goToFundDetail(row.code)">{{ signalName(row) }}</button>
            <span v-if="splitPositionKey(row.signal.fund_code).owner" class="owner-tag">{{ splitPositionKey(row.signal.fund_code).owner }}</span>
          </div>
          <div class="signal-header-state">
            <span v-if="collapsedStrategyFunds.has(row.signal.fund_code)" class="drag-indicator" title="长按拖动排序"><van-icon name="bars" /></span>
            <span v-if="row.signal._is_rebuy || row.signal.rebuy_recommendation" class="rebuy-badge">{{ rebuyLabel(row.signal) }}</span>
            <span class="regime-signal-icon" :title="`${regimeLabel(row.signal.market_analysis?.market_regime || row.signal.market_regime)}${row.signal.market_analysis?.regime_source === 'manual' ? '（手动）' : '（自动）'}`">{{ regimeIcon(row.signal.market_analysis?.market_regime || row.signal.market_regime) }}</span>
            <span class="signal-badge" :class="actionClass(row.signal)">{{ row.signal.signal_name || '观察' }}</span>
          </div>
        </header>
        <div v-if="!collapsedStrategyFunds.has(row.signal.fund_code)" class="signal-body">
          <p class="signal-reason signal-summary-highlight">{{ row.signal.reason || row.signal.alert_msg || '策略持续跟踪中' }}</p>
          <div v-if="row.signal._is_rebuy || row.signal.rebuy_recommendation" class="rebuy-panel">
            <div><b>{{ row.signal._is_rebuy ? '延迟回补已触发' : '延迟回补' }}</b><span>{{ row.signal.rebuy_recommendation?.reason || row.signal.reason }}</span></div>
            <div class="rebuy-command"><strong>建议回补 {{ formatMoney(row.signal.amount || row.signal.rebuy_recommendation?.amount) }}</strong><button type="button" @click="openRebuy(row)">执行回补</button></div>
          </div>
          <div v-if="row.signal.action === 'buy' && row.signal.amount" class="signal-command buy">建议买入 ¥{{ row.signal.amount.toFixed(2) }}</div>
          <div v-else-if="row.signal.action === 'sell'" class="signal-command sell">建议卖出 {{ row.signal.sell_shares || '--' }} 份</div>
          <div v-else-if="row.signal.alert" class="signal-command alert">{{ row.signal.alert_msg || '风险提示' }}</div>

          <div class="signal-meta signal-meta-highlight">
            <span v-if="strategyParams(row.signal).regime_first_build_ratio">建仓 {{ Math.round(Number(strategyParams(row.signal).regime_first_build_ratio) * 100) }}%</span>
            <span>持仓批次 {{ holdingBatchCount(row.position) }}</span>
          </div>
          <div v-if="row.signal.market_analysis?.day_changes?.length" class="trend-chart">
            <div v-for="day in recentChanges(row.signal)" :key="day.date" class="trend-day" :class="changeClass(day.change)" :title="`${day.date || ''} ${formatPercent(day.change)}`">
              <em>{{ formatPercent(day.change) }}</em><i :style="{ height: barHeight(row.signal, day.change) }"></i><small>{{ day.date?.slice(5).replace('-', '/') }}</small>
            </div>
          </div>
          <div v-if="signalStats(row.signal).length" class="signal-stats">
            <div class="signal-performance-stats">
              <span v-for="[label, value] in signalStats(row.signal)" :key="label"><b>{{ label }}</b><em :class="changeClass(value)">{{ formatPercent(value) }}</em></span>
              <span v-if="row.signal.market_analysis?.current_nav"><b>估算净值</b><em>{{ row.signal.market_analysis.current_nav.toFixed(4) }}</em></span>
            </div>
            <div class="signal-quality-stats">
              <span v-if="Number.isFinite(row.signal.market_analysis?.confidence)"><b>置信度</b><em>{{ Math.round(Number(row.signal.market_analysis?.confidence) * 100) }}%</em></span>
              <span v-if="strategyScoreFor(row) !== null"><b>基金适配评分</b><em>{{ strategyScoreFor(row) }}</em></span>
              <span v-if="row.signal.market_analysis?.strategy_params?.risk_multiplier" class="risk-multiplier"><b>风险系数</b><em>{{ row.signal.market_analysis.strategy_params.risk_multiplier }}x</em></span>
              <button class="inline-parameter" type="button" @click="openVolSensitivityEditor(row.signal.fund_code, row.position)">灵敏度 {{ strategyParams(row.signal).vol_sensitivity ?? 1 }}x</button>
              <button class="strategy-info-button" type="button" title="策略条件说明" @click="openStrategyInfo(row.signal)">?</button>
            </div>
          </div>
          <p v-if="row.signal.market_analysis?.decision_note" class="decision-note">{{ row.signal.market_analysis.decision_note }}</p>

          <div v-if="row.position && holdingBatchCount(row.position)" class="position-summary">
            <span>持仓金额 <b>{{ formatMoney(row.signal.market_analysis?.market_value ?? positionCost(row.position)) }}</b></span>
            <span v-if="Number.isFinite(row.signal.market_analysis?.unrealized_pnl)" :class="changeClass(row.signal.market_analysis?.unrealized_pnl)">浮动盈亏 <b>{{ formatMoney(row.signal.market_analysis?.unrealized_pnl) }} ({{ formatPercent(row.signal.market_analysis?.unrealized_pnl_pct) }})</b></span>
            <span v-if="Number.isFinite(row.signal.market_analysis?.cumulative_pnl)">累计盈亏 <b :class="changeClass(row.signal.market_analysis?.cumulative_pnl)">{{ formatMoney(row.signal.market_analysis?.cumulative_pnl) }}</b></span>
            <span>份额 <b>{{ positionShares(row.position).toFixed(2) }}</b></span>
            <span>批次 <b>{{ holdingBatchCount(row.position) }} 笔</b></span>
            <span>补仓 <b>{{ row.position.supplement_count || 0 }}/{{ strategyParams(row.signal).supplement_max_count || 3 }}</b></span>
            <button class="summary-parameter" type="button" @click="openMaxPositionEditor(row.signal.fund_code, row.position)">上限 <b>¥{{ row.position?.max_position || 5000 }}</b></button>
            <button class="summary-parameter" type="button" @click="openFeeScheduleEditor(row.signal.fund_code, row.position)">费率 <b>{{ formatFeeSchedule(row.position.fee_schedule).replaceAll(',', ' / ') }}</b></button>
          </div>
          <div v-else-if="row.position" class="watch-summary">空仓观察：{{ row.position.watch_note || row.position.note || '策略引擎正在监控建仓时机' }}，<button class="watch-parameter" type="button" @click="openMaxPositionEditor(row.signal.fund_code, row.position)">上限 {{ formatMoney(row.position.max_position || 5000, 0) }}</button></div>

          <div class="signal-actions position-actions">
            <button class="action-button" type="button" @click="openPositionEditor(row.signal.fund_code)"><van-icon name="plus" /> 买入观察</button>
            <button v-if="holdingBatchCount(row.position)" class="action-button sell" type="button" @click="openSellEditor(row.signal.fund_code, row.position, row.signal.sell_shares)"><van-icon name="cash-back-record" /> 买入卖出</button>
            <button class="action-button danger" type="button" @click="deletePosition(row.signal.fund_code)"><van-icon name="delete-o" /> 移除</button>
          </div>
          <div v-if="positionBatches(row.position).length || sellRecords(row.position).length" class="position-table-scroll">
            <table class="position-table">
              <thead><tr><th>批次</th><th>日期</th><th>金额</th><th>净值</th><th>份额</th><th>备注</th><th>操作</th></tr></thead>
              <tbody v-if="positionBatches(row.position).length">
                <tr v-for="batch in positionBatches(row.position)" :key="batch.id">
                  <td>{{ batch.id }}</td><td>{{ batch.buy_date }}</td><td>{{ formatMoney(batch.amount) }}</td>
                  <td><button class="table-action buy-nav-action" :class="{ recorded: Boolean(batch.nav) }" type="button" :title="batch.nav ? '编辑买入确认净值' : '补录买入确认净值'" @click="openBuyNavEditor(row.signal.fund_code, batch)"><span>{{ batch.nav ? batch.nav.toFixed(4) : '补录' }}</span><van-icon v-if="batch.nav" name="edit" /></button></td>
                  <td>{{ Number(batch.shares || 0).toFixed(2) }}</td><td>{{ batch.note || '--' }}</td>
                  <td><button class="table-action sell" type="button" @click="openBatchSell(row.signal.fund_code, batch)">卖</button><button class="table-action danger" type="button" @click="deleteBatch(row.signal.fund_code, batch.id)">×</button></td>
                </tr>
              </tbody>
              <tbody v-if="sellRecords(row.position).length">
                <tr class="sold-label"><td colspan="8">卖出记录</td></tr>
                <tr class="sold-table-heading"><th>来源批次</th><th>卖出日</th><th>买入净值</th><th>卖出净值</th><th>份额</th><th>持有天数</th><th>盈亏金额</th><th>收益率</th></tr>
                <tr v-for="record in sellRecords(row.position)" :key="record.id" class="sold-row">
                  <td>{{ record.batch_id }}</td><td>{{ record.sell_date }}</td><td>{{ record.buy_nav?.toFixed(4) || '--' }}</td>
                  <td><span v-if="record.sell_nav">{{ record.sell_nav.toFixed(4) }}</span><button v-else class="table-action" type="button" @click="fillSellNav(row.signal.fund_code, record.id)">补录</button></td>
                  <td>{{ Number(record.sell_shares || 0).toFixed(2) }}</td><td>{{ record.hold_days }} 天</td>
                  <td><b v-if="Number.isFinite(record.profit)" :class="changeClass(record.profit)">{{ formatMoney(record.profit) }}</b><span v-else>待确认</span></td>
                  <td><b :class="changeClass(record.profit_pct)">{{ formatPercent(record.profit_pct) }}</b><button class="table-action danger" type="button" @click="deleteSellRecord(row.signal.fund_code, record.id)">×</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </article>
      </div>
      </section>
    </van-pull-refresh>

    <van-popup v-model:show="addSectorOpen" position="bottom" round>
      <div class="native-dialog">
        <div class="dialog-title">新建估值板块 <van-icon name="cross" @click="addSectorOpen = false" /></div>
        <input v-model="newSectorName" autofocus placeholder="例如：半导体" @keyup.enter="addSector">
        <button class="command-button full" type="button" @click="addSector">创建板块</button>
      </div>
    </van-popup>

    <van-popup v-model:show="historyOpen" position="bottom" round :style="{ maxHeight: '76vh' }">
      <div class="history-panel">
        <div class="dialog-title">{{ historyTitle }} <van-icon name="cross" @click="historyOpen = false" /></div>
        <div v-if="historyLoading" class="loading-state"><van-loading size="20" /> 正在加载历史净值</div>
        <div v-else-if="!history.length" class="sector-empty">暂无历史净值</div>
        <div v-else class="history-list">
          <div v-for="item in history" :key="item.date" class="history-row">
            <span>{{ item.date }}</span><span>{{ Number.isFinite(item.nav) ? item.nav?.toFixed(4) : '--' }}</span><b :class="changeClass(item.change)">{{ formatPercent(item.change) }}</b>
          </div>
        </div>
      </div>
    </van-popup>

    <van-popup v-model:show="explanationOpen" position="bottom" round :style="{ maxHeight: '62vh' }">
      <div class="native-dialog info-dialog">
        <div class="dialog-title">{{ explanationTitle }} <van-icon name="cross" @click="explanationOpen = false" /></div>
        <p>{{ explanationText }}</p>
      </div>
    </van-popup>

    <van-popup v-model:show="positionEditorOpen" position="bottom" round :style="{ maxHeight: '88vh' }">
      <form class="native-dialog form-dialog" @submit.prevent="savePosition">
        <div class="dialog-title">
          <span>录入持仓</span>
          <span class="dialog-actions">
            <button class="icon-button quiet" type="button" title="从交易截图导入" aria-label="从交易截图导入" @click="triggerTradeImageImport"><van-icon name="photo-o" /></button>
            <van-icon name="cross" role="button" tabindex="0" aria-label="关闭" @click="positionEditorOpen = false" />
          </span>
        </div>
        <label v-if="importableHoldings.length">从现有持仓导入
          <select v-model="positionForm.importedHoldingCode" @change="importExistingHolding(positionForm.importedHoldingCode)">
            <option value="">手动录入</option>
            <option v-for="holding in importableHoldings" :key="holding.code" :value="holding.code">{{ holding.name }} ({{ holding.code }})</option>
          </select>
        </label>
        <label v-if="!positionForm.importedHoldingCode">基金代码<input v-model="positionForm.code" inputmode="numeric" maxlength="6" placeholder="6 位基金代码"></label>
        <div class="buy-amounts-field">
          <span>每笔买入金额与日期（金额留空为观察）</span>
          <div v-for="(row, index) in positionForm.buyRows" :key="index" class="buy-amount-row">
            <input v-model="row.amount" inputmode="decimal" :placeholder="`第 ${index + 1} 笔买入金额`">
            <input v-model="row.buyDate" type="date" :aria-label="`第 ${index + 1} 笔买入日期`">
            <button type="button" class="icon-button quiet" title="删除该笔买入" aria-label="删除该笔买入" @click="removeBuyRow(index)"><van-icon name="cross" /></button>
          </div>
          <button type="button" class="add-buy-amount" @click="addBuyRow"><van-icon name="plus" /> 增加一笔买入</button>
        </div>
        <label>确认净值（可选）<input v-model="positionForm.nav" inputmode="decimal" placeholder="未确认可留空"></label>
        <label>持仓上限<input v-model="positionForm.maxPosition" inputmode="decimal" placeholder="5000"></label>
        <label>备注（可选）<input v-model="positionForm.note" placeholder="空仓观察或买入备注"></label>
        <p class="form-hint">留空时只加入观察列表；每笔买入金额都会生成独立批次，并与后续卖出记录一起参与网格计算。</p>
        <button class="command-button full" type="submit" :disabled="positionSaving">{{ positionSaving ? '保存中...' : '保存' }}</button>
      </form>
    </van-popup>

    <van-popup v-model:show="tradeImportOpen" position="bottom" round :style="{ height: '90%' }">
      <div class="native-dialog trade-import-dialog">
        <div class="dialog-title">
          <span>图片交易导入</span>
          <van-icon name="cross" @click="tradeImportOpen = false" />
        </div>
        <div class="trade-import-context">
          <span>录入基金 <b>{{ normalizedPositionCode() }}</b></span>
          <span v-if="tradeImportFundName">图片基金 <b>{{ tradeImportFundName }}</b></span>
        </div>
        <div v-if="tradeImportRecognizing" class="loading-state compact"><van-loading size="20" /> {{ tradeImportStatus }}</div>
        <template v-else>
          <p class="form-hint trade-import-status">{{ tradeImportStatus }}</p>
          <div v-if="tradeImportRows.length" class="trade-import-list">
            <article v-for="row in tradeImportRows" :key="row.id" class="trade-import-row" :class="[`status-${row.status}`]">
              <div class="trade-import-row-head">
                <van-checkbox v-model="row.included" :disabled="row.status === 'imported'" />
                <select v-model="row.type" :disabled="row.status === 'imported'" aria-label="交易类型" @change="recalculateTradeImportRow(row, 'nav')">
                  <option value="buy">买入</option>
                  <option value="sell">卖出</option>
                </select>
                <label>下单日期<input v-model="row.date" :disabled="row.status === 'imported'" type="date" aria-label="下单日期" @change="applyTradeImportNav(row)"></label>
                <label>下单时间<input v-model="row.time" :disabled="row.status === 'imported'" type="time" step="1" aria-label="下单时间" @change="applyTradeImportNav(row)"></label>
                <span v-if="row.status === 'imported'" class="import-state success">已导入</span>
                <span v-else-if="row.status === 'failed'" class="import-state failed">失败</span>
              </div>
              <p v-if="row.description" class="trade-import-description">{{ row.description }}</p>
              <div class="trade-import-confirmation">
                <label>确认净值日<input v-model="row.navDate" :disabled="row.status === 'imported'" type="date" aria-label="确认净值日" @change="applySelectedTradeImportNav(row)"></label>
                <span v-if="isConversionTransferIn(row) && row.sourceNavDate">来源确认日 {{ row.sourceNavDate }}</span>
              </div>
              <div class="trade-import-values">
                <label>金额（元）<input v-model="row.amount" :disabled="row.status === 'imported'" inputmode="decimal" placeholder="0.00" @change="recalculateTradeImportRow(row, 'amount')"></label>
                <label>份额<input v-model="row.shares" :disabled="row.status === 'imported'" inputmode="decimal" placeholder="0.00" @change="recalculateTradeImportRow(row, 'shares')"></label>
                <label>确认净值<input v-model="row.nav" :disabled="row.status === 'imported'" inputmode="decimal" placeholder="需补充" @change="recalculateTradeImportRow(row, 'nav')"></label>
                <label v-if="isConversionTransferIn(row)">来源份额<input v-model="row.sourceShares" :disabled="row.status === 'imported'" inputmode="decimal" placeholder="0.00" @change="recalculateTradeImportRow(row, 'sourceNav')"></label>
                <label v-if="isConversionTransferIn(row)">来源净值<input v-model="row.sourceNav" :disabled="row.status === 'imported'" inputmode="decimal" placeholder="需补充" @change="recalculateTradeImportRow(row, 'sourceNav')"></label>
              </div>
            </article>
          </div>
          <div v-else class="sector-empty">暂无可导入流水</div>
          <button class="command-button full" type="button" :disabled="tradeImportSaving || !tradeImportRows.length" @click="importRecognizedTrades">
            {{ tradeImportSaving ? '导入中...' : `导入所选 ${selectedTradeImportRows().length} 笔` }}
          </button>
        </template>
      </div>
    </van-popup>

    <van-popup v-model:show="sellEditorOpen" position="bottom" round :style="{ maxHeight: '76vh' }">
      <form class="native-dialog form-dialog" @submit.prevent="saveSell">
        <div class="dialog-title">录入卖出 <van-icon name="cross" @click="sellEditorOpen = false" /></div>
        <p class="form-hint">{{ activePositionKey }} 当前可卖 {{ availableShares().toFixed(2) }} 份，将按先进先出顺序处理。</p>
        <label>卖出份额<input v-model="sellForm.shares" inputmode="decimal" placeholder="0"></label>
        <label>确认净值（可选）<input v-model="sellForm.nav" inputmode="decimal" placeholder="未确认可留空"></label>
        <label>卖出日期<input v-model="sellForm.sellDate" type="date"></label>
        <button class="command-button full" type="submit" :disabled="sellSaving">{{ sellSaving ? '保存中...' : '确认 FIFO 卖出' }}</button>
      </form>
    </van-popup>

    <van-popup v-model:show="batchSellOpen" position="bottom" round :style="{ maxHeight: '76vh' }">
      <form class="native-dialog form-dialog" @submit.prevent="saveBatchSell">
        <div class="dialog-title">录入批次卖出 <van-icon name="cross" @click="batchSellOpen = false" /></div>
        <div class="batch-sell-context">
          <span>批次 {{ activeBatch?.id }}</span><span>买入 {{ formatMoney(activeBatch?.amount) }}</span><span>净值 {{ activeBatch?.nav ? activeBatch.nav.toFixed(4) : '待补录' }}</span><span>持有 {{ holdingDays(activeBatch?.buyDate) }} 天</span>
        </div>
        <p class="form-hint">该批次可卖 {{ Number(activeBatch?.shares || 0).toFixed(2) }} 份，默认全卖；确认后会生成对应卖出记录。</p>
        <label>卖出份额<input v-model="batchSellForm.shares" type="number" inputmode="decimal" min="0.01" step="0.01" :max="activeBatch?.shares" placeholder="0"></label>
        <label>确认净值（可选）<input v-model="batchSellForm.nav" inputmode="decimal" placeholder="未确认可留空"></label>
        <label>卖出日期<input v-model="batchSellForm.sellDate" type="date"></label>
        <button class="command-button full" type="submit" :disabled="batchSellSaving">{{ batchSellSaving ? '保存中...' : '确认卖出' }}</button>
      </form>
    </van-popup>

    <van-popup v-model:show="buyNavEditorOpen" position="bottom" round teleport="body" :z-index="2001" :safe-area-inset-bottom="true" :style="{ maxHeight: '76vh' }">
      <form class="native-dialog form-dialog" @submit.prevent="saveBuyNav">
        <div class="dialog-title">{{ buyNavTarget?.currentNav ? '编辑买入净值' : '补录买入净值' }} <van-icon name="cross" @click="buyNavEditorOpen = false" /></div>
        <div class="batch-sell-context">
          <span>批次 {{ buyNavTarget?.batchId }}</span><span>日期 {{ buyNavTarget?.buyDate || '--' }}</span><span>金额 {{ formatMoney(buyNavTarget?.amount) }}</span>
        </div>
        <label>确认净值<input v-model="buyNavForm.value" type="number" inputmode="decimal" min="0.0001" step="0.0001" placeholder="请输入确认净值"></label>
        <p class="form-hint">保存后将按该净值重新计算本批次份额，并立即刷新持仓与策略结果。</p>
        <button class="command-button full" type="submit" :disabled="buyNavSaving">{{ buyNavSaving ? '保存中...' : (buyNavTarget?.currentNav ? '保存修改' : '确认补录') }}</button>
      </form>
    </van-popup>

    <van-popup v-model:show="strategyInfoOpen" position="bottom" round :style="{ maxHeight: '72vh' }">
      <div class="native-dialog strategy-info-dialog">
        <div class="dialog-title">策略条件 <van-icon name="cross" @click="strategyInfoOpen = false" /></div>
        <div class="strategy-rule"><b>买入</b><span>大跌 {{ strategyParams(strategyInfoSignal).dip_buy_threshold ?? '--' }}%，连续下跌、补仓间隔和趋势条件共同确认；延迟回补在触发净值回落后才执行。</span></div>
        <div class="strategy-rule"><b>卖出</b><span>冲高止盈、慢涨止盈、回撤止盈、趋势走弱与止损共同计算；实际卖出按选定批次或 FIFO 记录。</span></div>
        <div class="strategy-rule"><b>风控</b><span>止损阈值 {{ strategyParams(strategyInfoSignal).stop_loss_base ?? '--' }}%，灾难阈值 {{ strategyParams(strategyInfoSignal).disaster_loss_threshold ?? '--' }}%，风险系数 {{ strategyParams(strategyInfoSignal).risk_multiplier ?? 1 }}x，灵敏度 {{ strategyParams(strategyInfoSignal).vol_sensitivity ?? 1 }}x。</span></div>
      </div>
    </van-popup>

    <van-popup v-model:show="settingsOpen" position="bottom" round>
      <div class="native-dialog parameter-menu">
        <div class="dialog-title">参数修改 <van-icon name="cross" @click="settingsOpen = false" /></div>
        <button type="button" @click="openMaxPositionEditor(activePositionKey, activePosition || undefined)"><span>持仓上限</span><b>¥{{ activePosition?.max_position || 5000 }}</b><van-icon name="arrow" /></button>
        <button type="button" @click="openFeeScheduleEditor(activePositionKey, activePosition || undefined)"><span>卖出费率</span><b>{{ formatFeeSchedule(activePosition?.fee_schedule).replaceAll(',', ' / ') }}</b><van-icon name="arrow" /></button>
        <button type="button" @click="openVolSensitivityEditor(activePositionKey, activePosition || undefined)"><span>参数灵敏度</span><b>自动校准或手动设置</b><van-icon name="arrow" /></button>
      </div>
    </van-popup>

    <van-popup v-model:show="maxPositionEditorOpen" position="bottom" round>
      <form class="native-dialog form-dialog" @submit.prevent="saveMaxPosition">
        <div class="dialog-title">修改持仓上限 <van-icon name="cross" @click="maxPositionEditorOpen = false" /></div>
        <label>持仓上限<input v-model="maxPositionForm.value" inputmode="decimal" placeholder="5000"></label>
        <button class="command-button full" type="submit" :disabled="parameterSaving">{{ parameterSaving ? '保存中...' : '保存持仓上限' }}</button>
      </form>
    </van-popup>

    <van-popup v-model:show="feeScheduleEditorOpen" position="bottom" round :style="{ maxHeight: '72vh' }">
      <form class="native-dialog form-dialog" @submit.prevent="saveFeeSchedule">
        <div class="dialog-title">修改卖出费率 <van-icon name="cross" @click="feeScheduleEditorOpen = false" /></div>
        <label>费率（天数:百分比）<input v-model="feeScheduleForm.value" placeholder="7:1.5,30:0.5,0:0"></label>
        <p class="form-hint">例如 7:1.5,30:0.5,0:0 表示 7 天内 1.5%，30 天内 0.5%，之后 0%。</p>
        <button class="command-button full" type="submit" :disabled="parameterSaving">{{ parameterSaving ? '保存中...' : '保存卖出费率' }}</button>
      </form>
    </van-popup>

    <van-popup v-model:show="volSensitivityEditorOpen" position="bottom" round :style="{ maxHeight: '72vh' }">
      <form class="native-dialog form-dialog" @submit.prevent="saveVolSensitivity">
        <div class="dialog-title">参数灵敏度 <van-icon name="cross" @click="volSensitivityEditorOpen = false" /></div>
        <div v-if="volSensitivityLoading" class="loading-state"><van-loading size="20" /> 正在加载灵敏度</div>
        <template v-else>
          <p class="form-hint">当前生效 <b>{{ volSensitivityValue.toFixed(2) }}x</b>，{{ volSensitivity.source === 'manual' ? '手动设置' : volSensitivity.source === 'auto' ? '自动校准' : '默认值' }}。低于 1.00x 时阈值更灵敏，高于 1.00x 时阈值更宽松。</p>
          <label>灵敏度（0.5 - 1.5）<input v-model.number="volSensitivityValue" type="range" min="0.5" max="1.5" step="0.01"></label>
          <output class="sensitivity-value">{{ volSensitivityValue.toFixed(2) }}x</output>
          <div class="sensitivity-actions">
            <button type="button" class="action-button" :disabled="parameterSaving" @click="resetVolSensitivity">恢复自动</button>
            <button type="button" class="action-button" :disabled="parameterSaving" @click="recalibrateVolSensitivity">重新校准</button>
          </div>
          <button class="command-button full" type="submit" :disabled="parameterSaving">{{ parameterSaving ? '保存中...' : '手动设置' }}</button>
        </template>
      </form>
    </van-popup>
  </main>
</template>

<style scoped>
.grid-native-page { min-height: 100vh; padding-bottom: calc(68px + env(safe-area-inset-bottom, 0px)); background: var(--bg-primary); color: var(--text-primary); }
.grid-pull-refresh { min-height: calc(100vh - 68px - env(safe-area-inset-bottom, 0px)); }
.visually-hidden { position: fixed; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.grid-header { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; padding: calc(10px + env(safe-area-inset-top, 0px)) 14px 10px; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); }
.grid-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }.grid-heading h1 { margin: 0; font-size: 18px; line-height: 24px; font-weight: 650; }.grid-eyebrow { color: var(--color-primary); font-size: 12px; font-weight: 700; }.grid-header-actions { display: flex; align-items: center; gap: 8px; }.update-status { color: var(--text-secondary); font-size: 10px; white-space: nowrap; }
.icon-button { display: inline-grid; width: 30px; height: 30px; place-items: center; border: 1px solid transparent; border-radius: 4px; color: var(--text-primary); background: transparent; cursor: pointer; }.icon-button:disabled { opacity: .45; }.icon-button.quiet { color: var(--text-secondary); }.icon-button.danger { color: #ef4444; }.spinning { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
.valuation-workspace, .strategy-workspace { max-width: 1120px; margin: 0 auto; }.valuation-toolbar, .strategy-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 14px 10px; }.valuation-toolbar h2, .strategy-toolbar h2 { margin: 0; font-size: 16px; line-height: 22px; }.valuation-toolbar p, .strategy-toolbar p { margin: 2px 0 0; color: var(--text-secondary); font-size: 11px; }.command-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 30px; padding: 0 10px; border: 1px solid var(--color-primary); border-radius: 4px; background: var(--color-primary); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; }.command-button.full { width: 100%; margin-top: 12px; }
.load-error { margin: 0 14px 10px; padding: 8px 10px; border-left: 3px solid #ef4444; background: rgba(239,68,68,.08); color: #ef4444; font-size: 12px; }.loading-state, .empty-state { display: grid; place-items: center; gap: 8px; min-height: 170px; color: var(--text-secondary); font-size: 13px; text-align: center; }.empty-state p { margin: 0; color: var(--text-primary); }.empty-state span { font-size: 11px; }
.sector-tab-scroll { display: flex; gap: 7px; overflow-x: auto; padding: 10px 12px; border-top: 8px solid var(--bg-secondary); border-bottom: 1px solid var(--border-color); overscroll-behavior-x: contain; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }.sector-tab { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 6px; min-height: 30px; max-width: 180px; padding: 0 10px; overflow: hidden; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-secondary); background: var(--bg-secondary); font-size: 12px; font-weight: 600; cursor: pointer; }.sector-tab span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.sector-tab small { flex: 0 0 auto; color: inherit; font-size: 10px; font-weight: 500; }.sector-tab.active { border-color: var(--color-primary); color: var(--color-primary); background: var(--color-primary-bg); }.sector-panel-header { display: flex; align-items: center; justify-content: space-between; min-height: 42px; padding: 0 12px; border-bottom: 1px solid var(--border-color); }.sector-panel-title { display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; color: var(--text-primary); font-size: 14px; font-weight: 650; }.sector-panel-title small { color: var(--text-secondary); font-size: 10px; font-weight: 500; }.sector-actions { display: flex; align-items: center; gap: 2px; }.sector-empty { margin: 0; padding: 18px; color: var(--text-secondary); font-size: 12px; text-align: center; }
.valuation-table-scroll { overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; }.valuation-table { width: 100%; min-width: 790px; border-collapse: collapse; font-size: 12px; }.valuation-table th { height: 32px; padding: 0 10px; color: var(--text-secondary); font-size: 10px; font-weight: 500; text-align: right; white-space: nowrap; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); }.valuation-table th:first-child { position: sticky; left: 0; z-index: 3; text-align: left; background: var(--bg-secondary); }.valuation-table td { height: 48px; padding: 0 10px; border-bottom: 1px solid var(--border-color); text-align: right; white-space: nowrap; }.table-help { display: inline-flex; align-items: center; gap: 3px; padding: 0; border: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }.fund-cell { position: sticky; left: 0; z-index: 2; width: 236px; min-width: 236px; max-width: 236px; box-sizing: border-box; text-align: left !important; background: var(--bg-primary); box-shadow: 1px 0 0 var(--border-color); }.fund-code { margin: 0 7px 0 0; padding: 0; border: 0; color: var(--text-secondary); background: transparent; font-size: 10px; cursor: pointer; vertical-align: middle; }.fund-name { display: inline-block; max-width: 164px; overflow: hidden; padding: 0; border: 0; color: var(--text-primary); background: transparent; font-size: 12px; font-weight: 600; line-height: 18px; text-align: left; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }.fund-name-deep-link, .fund-name-remainder { padding: 0; border: 0; color: inherit; background: transparent; font: inherit; text-decoration: none; cursor: pointer; }.fund-name-deep-link:hover, .fund-name-remainder:hover { color: var(--color-primary); }.fitness { display: inline-flex; min-width: 24px; justify-content: center; padding: 1px 4px; border-radius: 3px; color: #fff; font-size: 9px; font-weight: 700; }.grade-a { background: #16a34a; }.grade-b { background: #65a30d; }.grade-c { background: #d97706; }.grade-d { background: #dc2626; }.numeric { font-variant-numeric: tabular-nums; }.up { color: var(--color-up) !important; }.down { color: var(--color-down) !important; }.flat { color: var(--text-secondary) !important; }.confidence { color: var(--text-primary); }.row-actions { min-width: 102px; }.row-actions .icon-button { width: 25px; height: 25px; }
.fund-adder { display: grid; grid-template-columns: 104px minmax(130px, 1fr) auto; gap: 6px; padding: 9px 12px; background: var(--bg-secondary); }.fund-adder input, .native-dialog input { width: 100%; height: 32px; padding: 0 9px; border: 1px solid var(--border-color); border-radius: 4px; outline: none; color: var(--text-primary); background: var(--bg-primary); font-size: 12px; }.fund-adder input:focus, .native-dialog input:focus { border-color: var(--color-primary); }
.regime-strip { display: flex; align-items: center; gap: 6px; margin: 0 14px 10px; padding: 8px 10px; border: 1px solid var(--border-color); border-radius: 5px; background: var(--bg-secondary); font-size: 11px; }.regime-strip > span { flex: 0 0 auto; color: var(--text-secondary); margin-right: 2px; white-space: nowrap; }.regime-strip button { flex: 0 0 auto; min-height: 26px; padding: 0 9px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-secondary); background: transparent; font-size: 11px; line-height: 1; white-space: nowrap; cursor: pointer; }.regime-strip button.active { border-color: var(--color-primary); color: var(--color-primary); background: var(--color-primary-bg); }.regime-strip small { min-width: 0; overflow: hidden; margin-left: auto; color: var(--text-secondary); text-overflow: ellipsis; white-space: nowrap; }
.budget-strip { display: flex; align-items: center; gap: 7px; padding: 5px 14px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 10px; }.budget-strip b { color: #059669; }.budget-track { flex: 1; height: 4px; overflow: hidden; border-radius: 2px; background: var(--border-color); }.budget-track i { display: block; height: 100%; border-radius: inherit; background: #f59e0b; }.strategy-commands { display: flex; align-items: center; gap: 5px; }.signal-card { margin: 0 10px 9px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-secondary); overflow: hidden; }.signal-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 42px; padding: 0 12px; border-bottom: 1px solid var(--border-color); }.signal-name { color: var(--text-primary); font-size: 13px; font-weight: 650; }.owner-tag { display: inline-flex; margin-left: 5px; padding: 1px 5px; border-radius: 3px; color: #4338ca; background: #e0e7ff; font-size: 9px; font-weight: 650; }.signal-badge { flex: 0 0 auto; padding: 3px 7px; border-radius: 3px; font-size: 10px; font-weight: 650; }.signal-badge.buy { color: #047857; background: rgba(16,185,129,.16); }.signal-badge.sell { color: #dc2626; background: rgba(239,68,68,.14); }.signal-badge.alert { color: #b45309; background: rgba(245,158,11,.16); }.signal-badge.hold { color: var(--text-secondary); background: var(--bg-primary); }.signal-body { padding: 10px 12px; }.signal-reason, .decision-note { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 18px; }.decision-note { margin-top: 9px; font-size: 11px; }.signal-command { margin-top: 8px; padding: 7px 9px; border-radius: 4px; font-size: 12px; font-weight: 650; }.signal-command.buy { color: #047857; background: rgba(16,185,129,.12); }.signal-command.sell { color: #dc2626; background: rgba(239,68,68,.12); }.signal-command.alert { color: #b45309; background: rgba(245,158,11,.12); }.rebuy-panel { display: grid; gap: 6px; margin-top: 8px; padding: 8px 9px; border: 1px solid #c7d2fe; border-radius: 5px; color: #4338ca; background: #eef2ff; font-size: 11px; }.rebuy-panel div:first-child { display: grid; gap: 2px; }.rebuy-command { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.rebuy-command button { min-height: 25px; padding: 0 8px; border: 0; border-radius: 4px; color: #fff; background: #4f46e5; font-size: 10px; font-weight: 650; }.signal-meta, .signal-stats { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 9px; color: var(--text-secondary); font-size: 10px; }.inline-parameter, .summary-parameter, .watch-parameter { padding: 0; border: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }.inline-parameter, .summary-parameter { border-bottom: 1px dashed var(--text-secondary); }.summary-parameter b { color: var(--text-primary); font-variant-numeric: tabular-nums; }.watch-parameter { color: #4338ca; border-bottom: 1px dashed #4338ca; }.signal-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }.action-button { display: inline-flex; align-items: center; gap: 4px; min-height: 27px; padding: 0 8px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-secondary); background: var(--bg-primary); font-size: 10px; cursor: pointer; }.action-button.sell, .action-button.danger { color: #dc2626; }.signal-stats { align-items: center; padding-top: 8px; border-top: 1px solid var(--border-color); }.signal-stats span { display: flex; gap: 5px; }.signal-stats b { color: var(--text-secondary); font-weight: 500; }.signal-stats em { font-style: normal; font-weight: 650; }.strategy-info-button { width: 18px; height: 18px; border: 1px solid var(--border-color); border-radius: 50%; color: var(--text-secondary); background: transparent; font-size: 10px; cursor: pointer; }.trend-chart { display: flex; align-items: stretch; gap: 3px; height: 76px; margin-top: 10px; padding: 2px 0; border-bottom: 1px solid var(--border-color); }.trend-day { display: grid; flex: 1; grid-template-rows: 18px 1fr 14px; align-items: end; min-width: 0; text-align: center; }.trend-day em { overflow: hidden; color: var(--text-secondary); font-size: 7px; font-style: normal; text-overflow: clip; white-space: nowrap; }.trend-day i { justify-self: center; width: min(100%, 13px); border-radius: 1px 1px 0 0; background: var(--text-secondary); }.trend-day.up i { background: var(--color-up); }.trend-day.down i { background: var(--color-down); }.trend-day small { overflow: hidden; color: var(--text-secondary); font-size: 7px; white-space: nowrap; }.position-summary { display: flex; flex-wrap: wrap; gap: 7px 12px; margin-top: 9px; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-secondary); background: var(--bg-primary); font-size: 10px; }.position-summary span { white-space: nowrap; }.position-summary b { color: var(--text-primary); font-variant-numeric: tabular-nums; }.watch-summary { margin-top: 9px; padding: 8px; border: 1px solid #c7d2fe; border-radius: 4px; color: #4338ca; background: #eef2ff; font-size: 11px; line-height: 17px; }.position-table-scroll { overflow-x: auto; margin: 9px -12px -10px; }.position-table { width: 100%; min-width: 660px; border-collapse: collapse; color: var(--text-secondary); font-size: 10px; }.position-table th, .position-table td { padding: 6px 7px; border-top: 1px solid var(--border-color); text-align: left; white-space: nowrap; }.position-table th { color: var(--text-secondary); font-weight: 500; background: var(--bg-primary); }.position-table td:first-child { color: var(--text-primary); font-family: ui-monospace, monospace; font-size: 9px; }.sold-label td { color: var(--text-secondary) !important; font-family: inherit !important; background: var(--bg-primary); }.sold-row { color: var(--text-secondary); }.table-action { margin-right: 5px; padding: 1px 4px; border: 1px solid #f59e0b; border-radius: 3px; color: #b45309; background: transparent; font-size: 9px; cursor: pointer; }.table-action.sell, .table-action.danger { border-color: transparent; color: #dc2626; }.table-action.danger { color: #9ca3af; }
.native-dialog, .history-panel { padding: 16px; background: var(--bg-secondary); }.dialog-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; color: var(--text-primary); font-size: 15px; font-weight: 650; }.dialog-title :deep(.van-icon) { color: var(--text-secondary); cursor: pointer; }.info-dialog p, .form-hint { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 19px; }.parameter-menu { display: grid; gap: 8px; }.parameter-menu button { display: grid; grid-template-columns: minmax(0, 1fr) auto 16px; align-items: center; gap: 8px; min-height: 42px; padding: 0 10px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); background: var(--bg-primary); font-size: 12px; text-align: left; cursor: pointer; }.parameter-menu button b { overflow: hidden; max-width: 180px; color: var(--text-secondary); font-size: 10px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }.parameter-menu button :deep(.van-icon) { color: var(--text-secondary); }.batch-sell-context { display: flex; flex-wrap: wrap; gap: 5px 10px; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-secondary); background: var(--bg-primary); font-size: 10px; font-variant-numeric: tabular-nums; }.batch-sell-context span { white-space: nowrap; }.strategy-info-dialog { display: grid; gap: 9px; }.strategy-rule { display: grid; grid-template-columns: 34px 1fr; gap: 8px; color: var(--text-secondary); font-size: 12px; line-height: 18px; }.strategy-rule b { align-self: start; padding: 1px 4px; border-radius: 3px; color: #4338ca; background: #eef2ff; font-size: 10px; text-align: center; }.form-dialog { display: grid; gap: 10px; }.form-dialog label { display: grid; gap: 5px; color: var(--text-secondary); font-size: 11px; }.form-dialog input { width: 100%; height: 34px; box-sizing: border-box; padding: 0 9px; border: 1px solid var(--border-color); border-radius: 4px; outline: none; color: var(--text-primary); background: var(--bg-primary); font-size: 13px; }.form-dialog input:focus { border-color: var(--color-primary); }.form-dialog .command-button { margin-top: 2px; }.history-list { max-height: 56vh; overflow-y: auto; }.history-row { display: grid; grid-template-columns: 1.2fr 1fr .8fr; min-height: 38px; align-items: center; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 12px; }.history-row b { text-align: right; font-variant-numeric: tabular-nums; }
.dialog-actions { display: flex; align-items: center; gap: 3px; }.dialog-actions .icon-button { width: 28px; height: 28px; }
.trade-import-dialog { display: flex; height: 100%; box-sizing: border-box; flex-direction: column; }.trade-import-context { display: flex; flex-wrap: wrap; gap: 5px 14px; margin-bottom: 8px; color: var(--text-secondary); font-size: 11px; }.trade-import-context b { color: var(--text-primary); }.loading-state.compact { min-height: 100px; }.trade-import-status { flex: 0 0 auto; padding-bottom: 8px; }.trade-import-list { flex: 1; min-height: 0; overflow-y: auto; border-top: 1px solid var(--border-color); }.trade-import-row { padding: 10px 0; border-bottom: 1px solid var(--border-color); }.trade-import-row.status-imported { opacity: .62; }.trade-import-row.status-failed { border-left: 3px solid #ef4444; padding-left: 8px; }.trade-import-row-head { display: grid; grid-template-columns: 24px 70px minmax(126px, 1fr) minmax(112px, .8fr) auto; align-items: end; gap: 6px; }.trade-import-row-head label, .trade-import-confirmation label { display: grid; gap: 3px; color: var(--text-secondary); font-size: 10px; }.trade-import-row-head select, .trade-import-row-head input, .trade-import-confirmation input, .trade-import-values input { width: 100%; height: 32px; box-sizing: border-box; padding: 0 7px; border: 1px solid var(--border-color); border-radius: 4px; outline: none; color: var(--text-primary); background: var(--bg-primary); font-size: 12px; }.trade-import-description { overflow: hidden; margin: 7px 0; color: var(--text-secondary); font-size: 10px; line-height: 15px; text-overflow: ellipsis; white-space: nowrap; }.trade-import-confirmation { display: flex; align-items: end; gap: 10px; margin: 7px 0; color: var(--text-secondary); font-size: 10px; }.trade-import-confirmation label { width: min(160px, 48%); }.trade-import-values { display: grid; grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); gap: 6px; }.trade-import-values label { display: grid; gap: 4px; color: var(--text-secondary); font-size: 10px; }.import-state { font-size: 10px; white-space: nowrap; }.import-state.success { color: #059669; }.import-state.failed { color: #dc2626; }
.signal-title-group { display: flex; min-width: 0; align-items: center; gap: 5px; overflow: hidden; white-space: nowrap; }.strategy-title { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; min-height: 28px; padding: 0; border: 0; color: var(--text-primary); background: transparent; cursor: pointer; }.strategy-code { color: var(--text-secondary); font-family: ui-monospace, monospace; font-size: 10px; font-weight: 500; text-decoration: none; }.strategy-code:hover { color: var(--color-primary); }.strategy-fund-name { min-width: 0; overflow: hidden; padding: 0; border: 0; color: var(--text-primary); background: transparent; font-size: 13px; font-weight: 650; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }.strategy-fund-name:hover { color: var(--color-primary); }.signal-header-state { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; }.rebuy-badge { max-width: 140px; overflow: hidden; padding: 3px 7px; border-radius: 10px; color: #047857; background: #d1fae5; font-size: 10px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.strategy-source-page { background: #f3f4f6; color: #1f2937; }.strategy-source-page .grid-header { position: relative; padding-top: calc(8px + env(safe-area-inset-top, 0px)); padding-bottom: 8px; color: #1f2937; background: #fff; border-color: #e5e7eb; }.strategy-source-page .grid-heading h1 { font-size: 15px; }.strategy-source-page .grid-eyebrow, .strategy-source-page .update-status { color: #64748b; }.strategy-source-page .icon-button { color: #64748b; }.source-grid-workspace { max-width: 1180px; padding: 0 8px 12px; background: #f3f4f6; }.source-grid-workspace .strategy-toolbar { padding: 8px 10px; margin: 0 -8px 6px; background: #fff; border-bottom: 1px solid #e5e7eb; }.source-grid-workspace .strategy-toolbar h2 { color: #111827; font-size: 14px; }.source-grid-workspace .strategy-toolbar p { color: #94a3b8; font-size: 10px; }.source-grid-workspace .command-button { min-height: 28px; padding: 0 9px; border-color: #f59e0b; background: #f59e0b; font-size: 11px; }.source-grid-workspace .regime-strip { margin: 0 0 6px; padding: 7px 9px; border-color: #e5e7eb; border-radius: 4px; background: #fff; color: #64748b; }.source-grid-workspace .regime-strip button { border-color: #e5e7eb; color: #64748b; }.source-grid-workspace .regime-strip button.active { border-color: #f59e0b; color: #b45309; background: #fffbeb; }.source-grid-workspace .budget-strip { margin: 0 -8px 6px; padding: 7px 10px; background: #fff; border-color: #e5e7eb; color: #94a3b8; }.source-grid-workspace .budget-strip b { color: #059669; }.source-grid-workspace .budget-track { background: #e5e7eb; }.source-grid-workspace .budget-track i { background: #f59e0b; }.source-grid-workspace .signal-card { margin: 0 0 8px; border-color: #e5e7eb; border-radius: 7px; background: #fff; box-shadow: 0 1px 2px rgba(15,23,42,.04); }.source-grid-workspace .signal-header { min-height: 34px; padding: 0 10px; border-color: #e5e7eb; }.source-grid-workspace .strategy-title, .source-grid-workspace .strategy-fund-name { color: #1d4ed8; }.source-grid-workspace .strategy-code { color: #4f46e5; font-size: 11px; font-weight: 650; }.source-grid-workspace .strategy-fund-name { font-size: 12px; font-weight: 600; }.source-grid-workspace .strategy-fund-name:hover { color: #1d4ed8; text-decoration: underline; }.source-grid-workspace .fitness { color: #fff; }.source-grid-workspace .signal-badge { border-radius: 3px; font-size: 10px; }.source-grid-workspace .signal-body { padding: 7px 10px 9px; }.source-grid-workspace .signal-reason { margin-bottom: 5px; color: #64748b; font-size: 11px; line-height: 16px; }.source-grid-workspace .signal-command { margin-top: 5px; padding: 5px 8px; border-radius: 4px; font-size: 11px; }.source-grid-workspace .signal-command.buy { color: #047857; background: #ecfdf5; border: 1px solid #a7f3d0; }.source-grid-workspace .signal-command.sell { color: #dc2626; background: #fef2f2; border: 1px solid #fecaca; }.source-grid-workspace .signal-command.alert { color: #92400e; background: #fffbeb; border: 1px solid #fde68a; }.source-grid-workspace .rebuy-panel { margin-top: 0; padding: 7px 9px; border: 2px solid #6366f1; border-radius: 5px; color: #3730a3; background: #eef2ff; }.source-grid-workspace .rebuy-command button { min-height: 24px; background: #4f46e5; }.source-grid-workspace .signal-meta { gap: 7px 14px; margin-top: 6px; padding: 4px 0; border-bottom: 1px solid #f1f5f9; color: #64748b; font-size: 10px; }.source-grid-workspace .inline-parameter { color: #64748b; border-color: #94a3b8; }.source-grid-workspace .signal-actions { gap: 6px; margin-top: 7px; }.source-grid-workspace .action-button { min-height: 25px; padding: 0 8px; border-color: #d1d5db; color: #475569; background: #fff; font-size: 10px; }.source-grid-workspace .action-button:first-child { color: #047857; border-color: #10b981; }.source-grid-workspace .action-button.sell { color: #dc2626; border-color: #f87171; }.source-grid-workspace .signal-stats { gap: 6px 13px; margin-top: 7px; padding: 5px 0; border-top: 0; border-bottom: 1px solid #e5e7eb; color: #64748b; font-size: 10px; }.source-grid-workspace .signal-stats b { color: #94a3b8; }.source-grid-workspace .strategy-info-button { border-color: #d1d5db; color: #94a3b8; }.source-grid-workspace .trend-chart { height: 82px; margin-top: 6px; padding: 3px 0; border-color: #e5e7eb; }.source-grid-workspace .trend-day em, .source-grid-workspace .trend-day small { color: #94a3b8; font-size: 8px; }.source-grid-workspace .trend-day i { background: #94a3b8; }.source-grid-workspace .trend-day.up i { background: #16a34a; }.source-grid-workspace .trend-day.down i { background: #ef4444; }.source-grid-workspace .decision-note { margin-top: 6px; padding: 6px 8px; border: 1px solid #bfdbfe; border-radius: 4px; color: #1e40af; background: #eff6ff; font-size: 10px; line-height: 16px; }.source-grid-workspace .position-summary { gap: 6px 13px; margin-top: 7px; padding: 7px 8px; border-color: #e5e7eb; border-radius: 4px; color: #64748b; background: #fff; font-size: 10px; }.source-grid-workspace .position-summary b { color: #1f2937; }.source-grid-workspace .summary-parameter { color: #64748b; border-color: #94a3b8; }.source-grid-workspace .watch-summary { margin-top: 7px; border-color: #bfdbfe; border-radius: 4px; color: #1e40af; background: #eff6ff; }.source-grid-workspace .position-table-scroll { margin: 7px -10px -9px; }.source-grid-workspace .position-table { min-width: 640px; color: #475569; font-size: 10px; }.source-grid-workspace .position-table th, .source-grid-workspace .position-table td { padding: 6px 8px; border-color: #edf2f7; }.source-grid-workspace .position-table th { color: #94a3b8; background: #f8fafc; }.source-grid-workspace .position-table td:first-child { color: #475569; }.source-grid-workspace .sold-label td { background: #f8fafc; }.source-grid-workspace .table-action { border-color: transparent; color: #dc2626; font-size: 10px; }.strategy-source-page .load-error { margin-right: 0; margin-left: 0; background: #fef2f2; }.strategy-source-page .empty-state, .strategy-source-page .loading-state { color: #64748b; background: #fff; }

:global([data-theme="dark"]) .strategy-source-page,
:global([data-theme="dark"]) .source-grid-workspace {
  background: var(--bg-primary);
  color: var(--text-primary);
}

:global([data-theme="dark"]) .strategy-source-page .grid-header,
:global([data-theme="dark"]) .source-grid-workspace .strategy-toolbar,
:global([data-theme="dark"]) .source-grid-workspace .regime-strip,
:global([data-theme="dark"]) .source-grid-workspace .budget-strip,
:global([data-theme="dark"]) .source-grid-workspace .signal-card,
:global([data-theme="dark"]) .source-grid-workspace .position-summary,
:global([data-theme="dark"]) .strategy-source-page .empty-state,
:global([data-theme="dark"]) .strategy-source-page .loading-state {
  background: var(--bg-secondary);
  border-color: var(--border-color);
}

:global([data-theme="dark"]) .strategy-source-page .grid-header,
:global([data-theme="dark"]) .source-grid-workspace .strategy-toolbar h2,
:global([data-theme="dark"]) .source-grid-workspace .position-summary b {
  color: var(--text-primary);
}

:global([data-theme="dark"]) .strategy-source-page .grid-eyebrow,
:global([data-theme="dark"]) .strategy-source-page .update-status,
:global([data-theme="dark"]) .strategy-source-page .icon-button,
:global([data-theme="dark"]) .source-grid-workspace .strategy-toolbar p,
:global([data-theme="dark"]) .source-grid-workspace .regime-strip,
:global([data-theme="dark"]) .source-grid-workspace .regime-strip button,
:global([data-theme="dark"]) .source-grid-workspace .budget-strip,
:global([data-theme="dark"]) .source-grid-workspace .signal-reason,
:global([data-theme="dark"]) .source-grid-workspace .signal-meta,
:global([data-theme="dark"]) .source-grid-workspace .signal-stats,
:global([data-theme="dark"]) .source-grid-workspace .signal-stats b,
:global([data-theme="dark"]) .source-grid-workspace .position-summary,
:global([data-theme="dark"]) .source-grid-workspace .position-table,
:global([data-theme="dark"]) .source-grid-workspace .position-table td:first-child,
:global([data-theme="dark"]) .strategy-source-page .empty-state,
:global([data-theme="dark"]) .strategy-source-page .loading-state {
  color: var(--text-secondary);
}

:global([data-theme="dark"]) .source-grid-workspace .regime-strip button,
:global([data-theme="dark"]) .source-grid-workspace .signal-card,
:global([data-theme="dark"]) .source-grid-workspace .signal-header,
:global([data-theme="dark"]) .source-grid-workspace .signal-meta,
:global([data-theme="dark"]) .source-grid-workspace .signal-stats,
:global([data-theme="dark"]) .source-grid-workspace .trend-chart,
:global([data-theme="dark"]) .source-grid-workspace .position-summary,
:global([data-theme="dark"]) .source-grid-workspace .position-table th,
:global([data-theme="dark"]) .source-grid-workspace .position-table td {
  border-color: var(--border-color);
}

:global([data-theme="dark"]) .source-grid-workspace .budget-track,
:global([data-theme="dark"]) .source-grid-workspace .position-table th,
:global([data-theme="dark"]) .source-grid-workspace .sold-label td {
  background: var(--bg-tertiary);
}

:global([data-theme="dark"]) .source-grid-workspace .action-button {
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-color: var(--border-color);
}

:global([data-theme="dark"]) .source-grid-workspace .watch-summary,
:global([data-theme="dark"]) .source-grid-workspace .decision-note,
:global([data-theme="dark"]) .source-grid-workspace .rebuy-panel {
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border-color: var(--border-color);
}

:global([data-theme="dark"]) .source-grid-workspace .strategy-info-button,
:global([data-theme="dark"]) .source-grid-workspace .inline-parameter,
:global([data-theme="dark"]) .source-grid-workspace .summary-parameter,
:global([data-theme="dark"]) .source-grid-workspace .trend-day em,
:global([data-theme="dark"]) .source-grid-workspace .trend-day small,
:global([data-theme="dark"]) .source-grid-workspace .trend-day i {
  color: var(--text-secondary);
  border-color: var(--border-color);
}
@media (max-width: 520px) { .grid-header { padding-right: 10px; padding-left: 10px; }.grid-heading h1 { font-size: 16px; }.update-status { display: none; }.valuation-toolbar, .strategy-toolbar { padding-right: 10px; padding-left: 10px; }.fund-adder { grid-template-columns: 88px 1fr auto; padding-right: 10px; padding-left: 10px; }.fund-adder input:nth-child(2) { min-width: 0; }.fund-adder .command-button { padding-right: 8px; padding-left: 8px; }.sector-tab-scroll { padding-right: 10px; padding-left: 10px; }.sector-panel-header { padding-right: 8px; padding-left: 8px; }.signal-card { margin-right: 8px; margin-left: 8px; }.source-grid-workspace .regime-strip { gap: 4px; padding: 6px; }.source-grid-workspace .regime-strip > span { margin-right: 0; font-size: 9px; }.source-grid-workspace .regime-strip button { min-height: 24px; padding: 0 5px; font-size: 10px; }.source-grid-workspace .regime-strip small { font-size: 9px; } }
.sold-table-heading th { color: var(--text-secondary); background: var(--bg-primary); font-size: 10px; font-weight: 500; }
.sensitivity-value { display: block; color: var(--color-primary); font-size: 16px; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums; }
.sensitivity-actions { display: flex; gap: 8px; }
.sensitivity-actions .action-button { flex: 1; justify-content: center; }
.trend-chart + .signal-stats { border-top: 0; }
.signal-stats .risk-multiplier { flex-basis: 100%; }
.buy-nav-action { display: inline-flex; align-items: center; gap: 3px; }
.buy-nav-action.recorded { border-color: transparent; color: var(--color-primary); }
.buy-nav-action.recorded :deep(.van-icon) { font-size: 10px; }
.valuation-table .fund-cell {
  height: auto;
  padding-top: 7px;
  padding-bottom: 7px;
  white-space: normal;
}
.fund-identity {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 7px;
}
.fund-identity .fund-code { margin: 0; }
.fund-identity .fund-name {
  display: block;
  max-width: none;
  overflow: visible;
  white-space: normal;
  overflow-wrap: anywhere;
  text-overflow: clip;
}
.valuation-table { min-width: 930px; }
.valuation-table .fund-cell { width: 112px; min-width: 112px; max-width: 112px; }
.fund-identity { grid-template-columns: minmax(0, 1fr); gap: 1px; }
.fund-name-full { min-width: 184px; max-width: 260px; text-align: left !important; white-space: normal !important; }
.fund-name-full button { width: 100%; overflow: hidden; padding: 0; border: 0; color: var(--text-primary); background: transparent; font: inherit; font-weight: 600; line-height: 18px; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.fund-name-full button:hover { color: var(--color-primary); }
</style>

<style scoped>
.signal-meta-highlight {
  margin-top: 10px;
  padding: 8px 9px;
  border: 1px solid rgba(245, 158, 11, .48);
  border-radius: 5px;
  background: rgba(255, 251, 235, .9);
  box-shadow: inset 3px 0 0 #f59e0b;
}
.signal-summary-highlight {
  margin: 0 0 7px;
  padding: 8px 9px;
  border: 1px solid rgba(96, 165, 250, .42);
  border-radius: 5px;
  background: rgba(239, 246, 255, .92);
  box-shadow: inset 3px 0 0 #60a5fa;
}
.signal-stats {
  display: grid;
  gap: 7px;
  justify-items: stretch;
}
.signal-performance-stats,
.signal-quality-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px 13px;
}
.signal-quality-stats { justify-content: center; }
.signal-quality-stats .risk-multiplier { flex-basis: auto; }
.signal-quality-stats .inline-parameter { color: var(--text-secondary); }
.regime-signal-icon { font-size: 14px; line-height: 1; }
.position-actions { margin-top: 10px; margin-bottom: 2px; }
:global([data-theme="dark"]) .signal-meta-highlight { background: rgba(120, 84, 20, .16); border-color: rgba(245, 158, 11, .42); }
:global([data-theme="dark"]) .signal-summary-highlight { background: rgba(30, 58, 95, .3); border-color: rgba(96, 165, 250, .4); }
</style>

<style>
/* This must remain unscoped: the theme attribute lives on <html>, outside the component scope. */
[data-theme="dark"] .strategy-source-page,
[data-theme="dark"] .strategy-source-page .source-grid-workspace {
  background: var(--bg-primary) !important;
  color: var(--text-primary) !important;
}

[data-theme="dark"] .strategy-source-page .grid-header,
[data-theme="dark"] .strategy-source-page .strategy-toolbar,
[data-theme="dark"] .strategy-source-page .regime-strip,
[data-theme="dark"] .strategy-source-page .budget-strip,
[data-theme="dark"] .strategy-source-page .signal-card,
[data-theme="dark"] .strategy-source-page .position-summary,
[data-theme="dark"] .strategy-source-page .empty-state,
[data-theme="dark"] .strategy-source-page .loading-state {
  background: var(--bg-secondary) !important;
  border-color: var(--border-color) !important;
}

[data-theme="dark"] .strategy-source-page .strategy-toolbar h2,
[data-theme="dark"] .strategy-source-page .strategy-title,
[data-theme="dark"] .strategy-source-page .strategy-fund-name,
[data-theme="dark"] .strategy-source-page .position-summary b {
  color: var(--text-primary) !important;
}

[data-theme="dark"] .strategy-source-page .grid-eyebrow,
[data-theme="dark"] .strategy-source-page .update-status,
[data-theme="dark"] .strategy-source-page .icon-button,
[data-theme="dark"] .strategy-source-page .strategy-toolbar p,
[data-theme="dark"] .strategy-source-page .regime-strip,
[data-theme="dark"] .strategy-source-page .regime-strip button,
[data-theme="dark"] .strategy-source-page .budget-strip,
[data-theme="dark"] .strategy-source-page .signal-reason,
[data-theme="dark"] .strategy-source-page .signal-meta,
[data-theme="dark"] .strategy-source-page .signal-stats,
[data-theme="dark"] .strategy-source-page .position-summary,
[data-theme="dark"] .strategy-source-page .position-table,
[data-theme="dark"] .strategy-source-page .position-table td:first-child,
[data-theme="dark"] .strategy-source-page .empty-state,
[data-theme="dark"] .strategy-source-page .loading-state {
  color: var(--text-secondary) !important;
}

[data-theme="dark"] .strategy-source-page .signal-header,
[data-theme="dark"] .strategy-source-page .signal-meta,
[data-theme="dark"] .strategy-source-page .signal-stats,
[data-theme="dark"] .strategy-source-page .trend-chart,
[data-theme="dark"] .strategy-source-page .position-summary,
[data-theme="dark"] .strategy-source-page .position-table th,
[data-theme="dark"] .strategy-source-page .position-table td {
  border-color: var(--border-color) !important;
}

[data-theme="dark"] .strategy-source-page .budget-track,
[data-theme="dark"] .strategy-source-page .position-table th,
[data-theme="dark"] .strategy-source-page .sold-label td,
[data-theme="dark"] .strategy-source-page .watch-summary,
[data-theme="dark"] .strategy-source-page .decision-note,
[data-theme="dark"] .strategy-source-page .rebuy-panel {
  background: var(--bg-tertiary) !important;
  border-color: var(--border-color) !important;
  color: var(--text-primary) !important;
}

[data-theme="dark"] .strategy-source-page .action-button {
  color: var(--text-secondary) !important;
  background: var(--bg-secondary) !important;
  border-color: var(--border-color) !important;
}

.form-dialog select {
  width: 100%;
  height: 34px;
  box-sizing: border-box;
  padding: 0 9px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  outline: none;
  color: var(--text-primary);
  background: var(--bg-primary);
  font-size: 13px;
}

.form-dialog select:focus { border-color: var(--color-primary); }

.buy-amounts-field { display: grid; gap: 5px; color: var(--text-secondary); font-size: 11px; }
.buy-amount-row { display: grid; grid-template-columns: minmax(92px, 1fr) minmax(126px, .9fr) 34px; gap: 6px; align-items: center; }
.buy-amount-row .icon-button { width: 34px; height: 34px; border-color: var(--border-color); }
.add-buy-amount { justify-self: start; display: inline-flex; align-items: center; gap: 4px; min-height: 28px; padding: 0 7px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--color-primary); background: var(--bg-primary); font-size: 11px; cursor: pointer; }

@media (max-width: 420px) {
  .trade-import-row-head { grid-template-columns: 24px 64px minmax(0, 1fr); }
  .trade-import-row-head label:last-of-type { grid-column: 3; }
  .trade-import-row-head .import-state { grid-column: 2 / -1; }
  .trade-import-values { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* Chinese market convention: red rises, green falls, including source-grid mode. */
.source-grid-workspace .trend-day.up i { background: #ef4444; }
.source-grid-workspace .trend-day.down i { background: #16a34a; }

/* Chinese-market convention: gains are red and losses are green. */
.strategy-source-page .trend-day.up i { background: #ef4444 !important; }
.strategy-source-page .trend-day.down i { background: #16a34a !important; }

/* Light mode uses restrained glass layers so repeated operational panels stay easy to scan. */
:root:not([data-theme="dark"]) .strategy-source-page {
  background: linear-gradient(160deg, #edf5ff 0%, #f8fbff 42%, #f4f8f4 100%);
}
:root:not([data-theme="dark"]) .source-grid-workspace {
  background: transparent;
}
:root:not([data-theme="dark"]) .source-grid-workspace .strategy-toolbar,
:root:not([data-theme="dark"]) .source-grid-workspace .regime-strip,
:root:not([data-theme="dark"]) .source-grid-workspace .budget-strip,
:root:not([data-theme="dark"]) .source-grid-workspace .signal-card,
:root:not([data-theme="dark"]) .source-grid-workspace .position-summary {
  background: rgba(255, 255, 255, .72);
  border-color: rgba(148, 163, 184, .28);
  box-shadow: 0 10px 28px rgba(71, 85, 105, .10);
  backdrop-filter: blur(14px);
}
:root:not([data-theme="dark"]) .source-grid-workspace .strategy-toolbar,
:root:not([data-theme="dark"]) .source-grid-workspace .budget-strip {
  margin-right: 0;
  margin-left: 0;
  border: 1px solid rgba(148, 163, 184, .24);
  border-radius: 8px;
}
.strategy-card-list { min-height: 1px; }
.signal-card-collapsed .signal-header { cursor: grab; touch-action: pan-y; user-select: none; }
.signal-card-chosen .signal-header { cursor: grabbing; }
.signal-card-ghost { opacity: .35; }
.signal-card-dragging { border-color: #f59e0b; box-shadow: 0 8px 22px rgba(15, 23, 42, .2); }
.drag-indicator { display: inline-flex; align-items: center; color: var(--text-secondary); font-size: 14px; }
</style>
