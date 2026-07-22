<script setup lang="ts">
import { ColorType, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchSectorDetail, type MarketSector, type MarketSectorType, type SectorTrendPoint } from '@/api/market'

const props = defineProps<{
  sectors: MarketSector[]
  type: MarketSectorType
  updatedAt: string | null
}>()

const emit = defineEmits<{
  close: []
  select: [sector: MarketSector]
  'type-change': [type: MarketSectorType]
}>()

type TrackerMode = 'line' | 'rank'
const MAX_SELECTED = 10
const chartElement = ref<HTMLDivElement | null>(null)
const selectedCodes = ref<string[]>([])
const selectorOpen = ref(true)
const searchText = ref('')
const mode = ref<TrackerMode>('line')
const trendByCode = ref<Record<string, SectorTrendPoint[]>>({})
const trendsLoading = ref(false)
const trendError = ref('')
const movementByCode = ref<Record<string, 'rise' | 'fall'>>({})
const chartMotion = ref<'rise' | 'fall' | ''>('')
let chart: IChartApi | null = null
let resizeObserver: ResizeObserver | null = null
let chartSeries: ISeriesApi<'Line'>[] = []
let loadRequestId = 0
let motionTimer: ReturnType<typeof setTimeout> | null = null
const previousFlowByCode = new Map<string, number>()

const lineColors = ['#ff4d57', '#00b8ec', '#ff9f43', '#a78bfa', '#33d1ba', '#f472b6', '#a3e635', '#facc15', '#60a5fa', '#fb7185']
const candidateMap = computed(() => new Map(props.sectors.map(sector => [sector.code, sector])))
const selectedSectors = computed(() => selectedCodes.value.map(code => candidateMap.value.get(code)).filter((sector): sector is MarketSector => Boolean(sector)))
const filteredSectors = computed(() => {
  const query = searchText.value.trim().toLowerCase()
  return props.sectors.filter(sector => !query || sector.name.toLowerCase().includes(query) || sector.code.toLowerCase().includes(query))
})
const dateLabel = computed(() => {
  if (!props.updatedAt) return '实时'
  const date = new Date(props.updatedAt)
  return Number.isNaN(date.getTime()) ? '实时' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
})
const typeLabel = computed(() => props.type === 'industry' ? '申万三级行业' : '东财概念')

function flowText(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  return `${value > 0 ? '+' : ''}${(value / 100000000).toFixed(2)}亿`
}

function defaultSelection() {
  const withFlow = props.sectors.filter(sector => Number.isFinite(sector.netInflow))
  const inflow = withFlow.filter(sector => (sector.netInflow || 0) > 0).sort((a, b) => (b.netInflow || 0) - (a.netInflow || 0)).slice(0, 5)
  const outflow = withFlow.filter(sector => (sector.netInflow || 0) < 0).sort((a, b) => (a.netInflow || 0) - (b.netInflow || 0)).slice(0, 5)
  return [...inflow, ...outflow].map(sector => sector.code)
}

function resetSelection() {
  selectedCodes.value = defaultSelection()
}

function toggleSector(sector: MarketSector) {
  if (selectedCodes.value.includes(sector.code)) {
    selectedCodes.value = selectedCodes.value.filter(code => code !== sector.code)
    return
  }
  if (selectedCodes.value.length >= MAX_SELECTED) return
  selectedCodes.value = [...selectedCodes.value, sector.code]
}

function clearSelection() {
  selectedCodes.value = []
}

function updateFlowMotion() {
  const nextMovement: Record<string, 'rise' | 'fall'> = {}
  let strongest: 'rise' | 'fall' | '' = ''
  props.sectors.forEach(sector => {
    const current = Number(sector.netInflow) || 0
    const previous = previousFlowByCode.get(sector.code)
    if (previous !== undefined && current !== previous && selectedCodes.value.includes(sector.code)) {
      const direction: 'rise' | 'fall' = current > previous ? 'rise' : 'fall'
      nextMovement[sector.code] = direction
      strongest = direction
    }
    previousFlowByCode.set(sector.code, current)
  })
  if (!Object.keys(nextMovement).length) return
  movementByCode.value = nextMovement
  chartMotion.value = strongest
  if (motionTimer) clearTimeout(motionTimer)
  motionTimer = setTimeout(() => {
    movementByCode.value = {}
    chartMotion.value = ''
  }, 900)
}

function chartTime(value: string): UTCTimestamp | null {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/)
  if (!matched) return null
  const [, year, month, day, hour, minute] = matched
  return Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) / 1000) as UTCTimestamp
}

function cumulativeSeries(points: SectorTrendPoint[]) {
  let cumulative = 0
  return points
    .map(point => {
      const time = chartTime(point.time)
      if (point.netInflow !== null && Number.isFinite(point.netInflow)) cumulative += point.netInflow
      return time === null ? null : { time, value: cumulative }
    })
    .filter((point): point is { time: UTCTimestamp, value: number } => point !== null)
}

function destroyChart() {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.remove()
  chart = null
  chartSeries = []
}

function renderChart() {
  destroyChart()
  const container = chartElement.value
  if (!container || mode.value !== 'line' || !selectedSectors.value.length) return
  chart = createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: { background: { type: ColorType.Solid, color: '#101b30' }, textColor: '#9aa9c0', attributionLogo: false },
    grid: { vertLines: { color: 'rgba(151, 170, 201, .12)' }, horzLines: { color: 'rgba(151, 170, 201, .12)' } },
    rightPriceScale: { borderColor: 'rgba(151, 170, 201, .18)' },
    timeScale: { borderColor: 'rgba(151, 170, 201, .18)', timeVisible: true, secondsVisible: false, rightOffset: 2, barSpacing: 6 },
    crosshair: { vertLine: { color: 'rgba(162, 191, 230, .35)' }, horzLine: { color: 'rgba(162, 191, 230, .35)' } },
    localization: { priceFormatter: value => `${value >= 0 ? '+' : ''}${(value / 100000000).toFixed(0)}亿` },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true }
  })
  selectedSectors.value.forEach((sector, index) => {
    const series = cumulativeSeries(trendByCode.value[sector.code] || [])
    if (!series.length) return
    const line = chart?.addSeries(LineSeries, { color: lineColors[index], lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: true })
    line?.setData(series)
    if (line) chartSeries.push(line)
  })
  chart.timeScale().fitContent()
  resizeObserver = new ResizeObserver(() => {
    if (chart && container.clientWidth > 0) chart.applyOptions({ width: container.clientWidth })
  })
  resizeObserver.observe(container)
}

async function loadTrends(silent = false) {
  const requestId = ++loadRequestId
  trendError.value = ''
  if (!selectedSectors.value.length) {
    trendByCode.value = {}
    renderChart()
    return
  }
  if (!silent) trendsLoading.value = true
  try {
    const results = await Promise.allSettled(selectedSectors.value.map(async sector => {
      const detail = await fetchSectorDetail(sector.code, sector.name, props.type, '1d')
      return [sector.code, detail.trend.points] as const
    }))
    if (requestId !== loadRequestId) return
    const next: Record<string, SectorTrendPoint[]> = {}
    results.forEach(result => {
      if (result.status === 'fulfilled') next[result.value[0]] = result.value[1]
    })
    trendByCode.value = next
    if (!Object.keys(next).length) trendError.value = '暂未获取到板块分时资金数据'
    await nextTick()
    renderChart()
  } finally {
    if (requestId === loadRequestId && !silent) trendsLoading.value = false
  }
}

watch(() => props.type, async () => {
  selectedCodes.value = defaultSelection()
  await nextTick()
  loadTrends()
})
watch(() => props.sectors, async () => {
  if (!props.sectors.length) return
  updateFlowMotion()
  if (!selectedCodes.value.length) {
    resetSelection()
    return
  }
  const validCodes = selectedCodes.value.filter(code => candidateMap.value.has(code))
  if (validCodes.length !== selectedCodes.value.length) {
    selectedCodes.value = validCodes
    return
  }
  await loadTrends(true)
})
watch(selectedCodes, () => loadTrends(), { deep: true })
watch(mode, async () => {
  await nextTick()
  renderChart()
})

onMounted(() => {
  resetSelection()
})
onBeforeUnmount(() => {
  destroyChart()
  if (motionTimer) clearTimeout(motionTimer)
})
</script>

<template>
  <section class="sector-flow-tracker" aria-label="实时板块资金流向追踪">
    <header class="tracker-header">
      <div><h2>实时板块资金流向追踪</h2><p>{{ typeLabel }} · 分时资金走势</p></div>
      <div class="tracker-actions">
        <div class="tracker-type-switch" role="tablist" aria-label="板块类别"><button :class="{ active: type === 'industry' }" type="button" @click="emit('type-change', 'industry')">行业</button><button :class="{ active: type === 'concept' }" type="button" @click="emit('type-change', 'concept')">概念</button></div>
        <button class="tracker-close" type="button" aria-label="关闭资金流向追踪" @click="emit('close')">×</button>
      </div>
    </header>

    <div class="selected-heading"><span>当前对比板块（{{ selectedSectors.length }}/{{ MAX_SELECTED }}）</span><button type="button" @click="resetSelection"><van-icon name="replay" /> 一键复位</button></div>
    <div class="selected-tags">
      <button v-for="(sector, index) in selectedSectors" :key="sector.code" type="button" :class="['selected-tag', movementByCode[sector.code]]" :style="{ '--tag-color': lineColors[index] }" @click="toggleSector(sector)">{{ sector.name }} <strong>{{ flowText(sector.netInflow) }}</strong><van-icon name="cross" /></button>
      <span v-if="!selectedSectors.length" class="selection-empty">请选择至少一个板块</span>
    </div>

    <section class="selector-panel">
      <div class="selector-head"><strong>选择更多板块（全部 {{ sectors.length }} 个）</strong><button type="button" @click="selectorOpen = !selectorOpen">{{ selectorOpen ? '收起板块' : '展开板块' }} <van-icon :name="selectorOpen ? 'arrow-up' : 'arrow-down'" /></button></div>
      <div v-if="selectorOpen" class="selector-content">
        <label class="sector-search"><van-icon name="search" /><input v-model="searchText" type="search" placeholder="搜索板块名称..." /></label>
        <div class="sector-options">
          <button v-for="sector in filteredSectors" :key="sector.code" type="button" :class="{ selected: selectedCodes.includes(sector.code), blocked: !selectedCodes.includes(sector.code) && selectedCodes.length >= MAX_SELECTED }" @click="toggleSector(sector)"><span>{{ sector.name }}</span><strong :class="(sector.netInflow || 0) >= 0 ? 'inflow' : 'outflow'">{{ flowText(sector.netInflow) }}</strong></button>
        </div>
      </div>
    </section>

    <section class="tracker-chart-section">
      <div class="chart-controls"><div class="chart-mode"><button type="button" :class="{ active: mode === 'line' }" @click="mode = 'line'"><van-icon name="chart-trending-o" /> 分时折线</button><button type="button" :class="{ active: mode === 'rank' }" @click="mode = 'rank'"><van-icon name="bar-chart-o" /> 排名对比</button></div><time>{{ dateLabel }}</time></div>
      <div v-if="mode === 'line'" :class="['tracker-chart-wrap', chartMotion]"><div ref="chartElement" class="tracker-chart" /><div v-if="trendsLoading" class="chart-state">正在加载已选板块的分时资金...</div><div v-else-if="trendError" class="chart-state">{{ trendError }}</div><div v-else-if="selectedSectors.length && !chartSeries.length" class="chart-state">暂无可绘制的分时资金数据</div></div>
      <div v-else class="flow-ranking"><button v-for="(sector, index) in selectedSectors.slice().sort((a, b) => (b.netInflow || 0) - (a.netInflow || 0))" :key="sector.code" type="button" @click="emit('select', sector)"><span>{{ sector.name }}</span><i :class="(sector.netInflow || 0) >= 0 ? 'inflow' : 'outflow'" :style="{ width: `${Math.max(4, Math.abs(sector.netInflow || 0) / Math.max(...selectedSectors.map(item => Math.abs(item.netInflow || 0)), 1) * 100)}%`, '--rank-color': lineColors[index] }" /><strong :class="(sector.netInflow || 0) >= 0 ? 'inflow' : 'outflow'">{{ flowText(sector.netInflow) }}</strong></button></div>
    </section>
    <footer class="tracker-footer"><span><i class="inflow-dot" /> 资金流入</span><span><i class="outflow-dot" /> 资金流出</span><small>分时折线为各板块主力净流入累计值</small></footer>
  </section>
</template>

<style scoped>
.sector-flow-tracker { overflow: hidden; color: #e7effd; background: #101b30; }.tracker-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 64px; padding: 10px 14px 9px 18px; border-bottom: 1px solid rgba(154, 180, 224, .16); }.tracker-header h2 { margin: 0; font-size: 17px; font-weight: 650; }.tracker-header p { margin: 3px 0 0; color: #91a1bd; font-size: 11px; }.tracker-actions { display: inline-flex; align-items: center; gap: 8px; }.tracker-type-switch, .chart-mode { display: inline-flex; overflow: hidden; padding: 2px; border: 1px solid rgba(154, 180, 224, .18); border-radius: 5px; background: rgba(0, 0, 0, .12); }.tracker-type-switch button, .chart-mode button { height: 25px; padding: 0 8px; border: 0; border-radius: 3px; color: #9eacc4; background: transparent; font-size: 11px; cursor: pointer; }.tracker-type-switch button.active, .chart-mode button.active { color: #071326; background: #72ddf6; font-weight: 650; }.tracker-close { display: grid; width: 30px; height: 30px; place-items: center; border: 0; border-radius: 50%; color: #e7effd; background: rgba(231, 239, 253, .13); font-size: 25px; cursor: pointer; }
.selected-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 18px 7px; color: #aab7cd; font-size: 12px; }.selected-heading button, .selector-head button { display: inline-flex; align-items: center; gap: 3px; padding: 0; border: 0; color: #63d9fb; background: transparent; font-size: 11px; cursor: pointer; }.selected-tags { display: flex; min-height: 38px; flex-wrap: wrap; gap: 7px; padding: 0 18px 12px; }.selected-tag { display: inline-flex; height: 27px; align-items: center; gap: 5px; padding: 0 8px; border: 1px solid var(--tag-color); border-radius: 5px; color: #eaf3ff; background: rgba(13, 25, 46, .56); font-size: 11px; cursor: pointer; transition: background .3s ease, box-shadow .3s ease; }.selected-tag.rise { animation: flow-rise .8s ease-out; }.selected-tag.fall { animation: flow-fall .8s ease-out; }.selected-tag strong { color: var(--tag-color); font-variant-numeric: tabular-nums; }.selection-empty { color: #8492ac; font-size: 12px; }
.selector-panel { margin: 0 14px; overflow: hidden; border: 1px solid rgba(154, 180, 224, .1); border-radius: 7px; background: rgba(33, 48, 79, .48); }.selector-head { display: flex; min-height: 40px; align-items: center; justify-content: space-between; padding: 0 12px; color: #aab7cd; font-size: 11px; }.selector-content { padding: 0 12px 12px; }.sector-search { display: flex; width: min(288px, 100%); height: 30px; align-items: center; gap: 6px; padding: 0 9px; border-radius: 5px; color: #92a2bc; background: #0d172a; }.sector-search input { min-width: 0; flex: 1; border: 0; outline: 0; color: #e7effd; background: transparent; font: inherit; font-size: 11px; }.sector-search input::placeholder { color: #74839e; }.sector-options { display: flex; max-height: 137px; flex-wrap: wrap; gap: 6px; overflow-y: auto; margin-top: 9px; padding-right: 3px; }.sector-options button { display: inline-flex; max-width: 160px; min-height: 28px; align-items: center; gap: 5px; padding: 0 7px; border: 1px solid transparent; border-radius: 5px; color: #c7d2e5; background: #16233c; font-size: 10px; cursor: pointer; }.sector-options button.selected { border-color: #63d9fb; background: rgba(29, 137, 170, .22); }.sector-options button.blocked { opacity: .47; }.sector-options span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.sector-options strong { font-size: 9px; font-variant-numeric: tabular-nums; }.inflow { color: #ff6670; }.outflow { color: #37d59b; }
.tracker-chart-section { padding: 14px; }.chart-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 9px; }.chart-mode button { display: inline-flex; align-items: center; gap: 3px; }.chart-controls time { color: #95a4bd; font-size: 11px; }.tracker-chart-wrap { position: relative; height: 300px; overflow: hidden; border: 1px solid rgba(154, 180, 224, .14); border-radius: 5px; background: #101b30; }.tracker-chart-wrap.rise { animation: chart-rise .8s ease-out; }.tracker-chart-wrap.fall { animation: chart-fall .8s ease-out; }.tracker-chart { width: 100%; height: 100%; }.chart-state { position: absolute; top: 50%; right: 16px; left: 16px; color: #9dacc5; font-size: 12px; text-align: center; transform: translateY(-50%); pointer-events: none; }.flow-ranking { display: grid; min-height: 300px; gap: 9px; align-content: center; padding: 14px; border: 1px solid rgba(154, 180, 224, .14); border-radius: 5px; background: #101b30; }.flow-ranking button { display: grid; grid-template-columns: minmax(70px, 130px) minmax(26px, 1fr) 75px; align-items: center; gap: 9px; width: 100%; min-height: 20px; padding: 0; border: 0; color: #d7e1f1; background: transparent; font-size: 11px; text-align: left; cursor: pointer; }.flow-ranking button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.flow-ranking button i { height: 9px; min-width: 3px; border-radius: 2px; background: var(--rank-color); transition: width .6s cubic-bezier(.16, 1, .3, 1); }.flow-ranking button i.outflow { opacity: .72; }.flow-ranking button strong { text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; }.tracker-footer { display: flex; min-height: 40px; align-items: center; gap: 12px; padding: 0 18px; border-top: 1px solid rgba(154, 180, 224, .15); color: #9aa9c0; font-size: 11px; }.tracker-footer span { display: inline-flex; align-items: center; gap: 4px; }.tracker-footer small { margin-left: auto; color: #7585a1; font-size: 10px; }.inflow-dot, .outflow-dot { width: 7px; height: 7px; border-radius: 50%; }.inflow-dot { background: #ff6670; }.outflow-dot { background: #37d59b; }
@keyframes flow-rise { 0%, 100% { box-shadow: none; background: rgba(13, 25, 46, .56); } 45% { box-shadow: 0 0 14px rgba(255, 91, 104, .54); background: rgba(255, 91, 104, .18); } } @keyframes flow-fall { 0%, 100% { box-shadow: none; background: rgba(13, 25, 46, .56); } 45% { box-shadow: 0 0 14px rgba(48, 213, 153, .5); background: rgba(48, 213, 153, .15); } } @keyframes chart-rise { 45% { box-shadow: inset 0 0 38px rgba(255, 91, 104, .18); } } @keyframes chart-fall { 45% { box-shadow: inset 0 0 38px rgba(48, 213, 153, .16); } }
@media (max-width: 600px) { .tracker-header { padding-left: 14px; }.tracker-header h2 { font-size: 15px; }.tracker-header p { display: none; }.selected-heading, .selected-tags { padding-right: 14px; padding-left: 14px; }.selector-panel, .tracker-chart-section { margin-right: 10px; margin-left: 10px; }.tracker-chart-section { padding: 14px 0; }.tracker-chart-wrap { height: 260px; }.tracker-footer { padding: 0 14px; }.tracker-footer small { display: none; }.sector-options { max-height: 156px; }.flow-ranking button { grid-template-columns: 84px minmax(24px, 1fr) 68px; } }
</style>
