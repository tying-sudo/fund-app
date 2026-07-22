<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from 'lightweight-charts'
import { fetchAccumulatedReturn, fetchTimeShareData, type AccumulatedReturnData, type TimeShareData } from '@/api/fund'
import { fetchNetValueHistoryFast } from '@/api/fundFast'
import type { NetValueRecord } from '@/types/fund'
import { getBeijingDateString } from '@/utils/tradingDate'

type PerformancePeriod = '1d' | '1m' | '3m' | '6m' | '1y' | '3y' | 'all'
type SeriesKey = 'fund' | 'average' | 'index'

interface ChartPoint extends AccumulatedReturnData {
  timestamp: UTCTimestamp
}

const props = defineProps<{
  fundCode: string
  realtimeValue: number
  realtimeChange: number
}>()

const periods: Array<{ value: PerformancePeriod; label: string; range: string }> = [
  { value: '1d', label: '分时', range: '' },
  { value: '1m', label: '近1月', range: 'y' },
  { value: '3m', label: '近3月', range: '3y' },
  { value: '6m', label: '近6月', range: '6y' },
  { value: '1y', label: '近1年', range: '1n' },
  { value: '3y', label: '近3年', range: '3n' },
  { value: 'all', label: '成立来', range: 'ln' }
]

const period = ref<PerformancePeriod>('1d')
const chartElement = ref<HTMLDivElement | null>(null)
const chartData = ref<ChartPoint[]>([])
const history = ref<NetValueRecord[]>([])
const visibleHistoryCount = ref(5)
const loading = ref(true)
const loadError = ref('')
const activePoint = ref<ChartPoint | null>(null)
const seriesVisible = ref<Record<SeriesKey, boolean>>({ fund: true, average: true, index: true })

let chart: IChartApi | null = null
let fundSeries: ISeriesApi<'Area'> | null = null
let averageSeries: ISeriesApi<'Line'> | null = null
let indexSeries: ISeriesApi<'Line'> | null = null
let resizeObserver: ResizeObserver | null = null
let pointByTime = new Map<number, ChartPoint>()
let requestId = 0
let intradayTimer: ReturnType<typeof setInterval> | null = null
let intradayPolling = false

const selectedPeriod = computed(() => periods.find(item => item.value === period.value) ?? periods[0]!)
const visibleHistory = computed(() => history.value.slice(0, visibleHistoryCount.value))
const canLoadMore = computed(() => visibleHistoryCount.value < history.value.length)
const latestPoint = computed(() => activePoint.value ?? chartData.value.at(-1) ?? null)

const fundLineColor = computed(() => (latestPoint.value?.fundReturn ?? 0) >= 0 ? '#f6465d' : '#0ecb81')
const fundFillColor = computed(() => (latestPoint.value?.fundReturn ?? 0) >= 0 ? 'rgba(246, 70, 93, .16)' : 'rgba(14, 203, 129, .16)')
const legendItems = computed(() => period.value === '1d'
  ? [{ key: 'fund' as const, label: '估算净值', value: latestPoint.value?.fundReturn ?? null, color: fundLineColor.value }]
  : [
      { key: 'fund' as const, label: '本基金', value: latestPoint.value?.fundReturn ?? null, color: fundLineColor.value },
      { key: 'average' as const, label: '同类平均', value: latestPoint.value?.avgReturn ?? null, color: '#31a7ba' },
      { key: 'index' as const, label: '沪深300', value: latestPoint.value?.indexReturn ?? null, color: '#7d899d' }
    ])

function toTimestamp(date: string): UTCTimestamp | null {
  const matched = date.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!matched) return null
  return Math.floor(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]), Number(matched[4] || 0), Number(matched[5] || 0), Number(matched[6] || 0)) / 1000) as UTCTimestamp
}

function normalizeData(items: AccumulatedReturnData[]) {
  const deduped = new Map<string, AccumulatedReturnData>()
  items.forEach(item => {
    if (!item.date || !Number.isFinite(item.fundReturn)) return
    deduped.set(item.date, item)
  })
  return [...deduped.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map(item => ({ ...item, timestamp: toTimestamp(item.date) }))
    .filter((item): item is AccumulatedReturnData & { timestamp: UTCTimestamp } => item.timestamp !== null)
}

function normalizeTimeShare(items: TimeShareData[]) {
  const date = getBeijingDateString()
  const mapped = items
    .map(item => {
      const value = Number(item.value)
      const change = Number(item.change)
      const time = /^\d{4}-\d{2}-\d{2}/.test(item.time) ? item.time : `${date} ${item.time.slice(0, 5)}`
      return { date: time, value, change: Number.isFinite(change) ? change : Number.NaN }
    })
    .filter(item => Number.isFinite(item.value))
    .sort((left, right) => left.date.localeCompare(right.date))
  const base = mapped[0]?.value
  if (!base || base <= 0) return []
  return normalizeData(mapped.map(item => ({
    date: item.date,
    fundReturn: Number.isFinite(item.change) ? item.change : ((item.value - base) / base) * 100,
    avgReturn: Number.NaN,
    indexReturn: Number.NaN
  })))
}

function appendRealtimePoint(source: ChartPoint[]) {
  if (period.value !== '1d' || !Number.isFinite(props.realtimeChange)) return source
  const now = new Date()
  const date = `${getBeijingDateString()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const timestamp = toTimestamp(date)
  if (timestamp === null) return source
  const point: ChartPoint = {
    date,
    timestamp,
    fundReturn: props.realtimeChange,
    avgReturn: Number.NaN,
    indexReturn: Number.NaN
  }
  const next = [...source]
  const last = next.at(-1)
  if (last?.date === date) next[next.length - 1] = point
  else next.push(point)
  return next
}

function fallbackFromHistory(items: NetValueRecord[]) {
  const days = period.value === '1m' ? 35 : period.value === '3m' ? 110 : period.value === '6m' ? 200 : period.value === '1y' ? 400 : period.value === '3y' ? 1100 : 5000
  const ordered = [...items].slice(0, days).reverse()
  const base = ordered[0]?.netValue
  if (!base || base <= 0) return []
  return normalizeData(ordered.map(item => ({
    date: item.date,
    fundReturn: ((item.netValue - base) / base) * 100,
    avgReturn: Number.NaN,
    indexReturn: Number.NaN
  })))
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function tone(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return ''
  return value > 0 ? 'up' : 'down'
}

function disposeChart() {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.remove()
  chart = null
  fundSeries = null
  averageSeries = null
  indexSeries = null
  activePoint.value = null
  pointByTime = new Map()
}

function stopIntradayPolling() {
  if (intradayTimer) clearInterval(intradayTimer)
  intradayTimer = null
}

function syncChartData() {
  if (!chart || !fundSeries || !averageSeries || !indexSeries) return
  const source = chartData.value
  fundSeries.applyOptions({ lineColor: fundLineColor.value, topColor: fundFillColor.value })
  fundSeries.setData(source.map(item => ({ time: item.timestamp, value: item.fundReturn })))
  averageSeries.setData(source.filter(item => Number.isFinite(item.avgReturn)).map(item => ({ time: item.timestamp, value: item.avgReturn })))
  indexSeries.setData(source.filter(item => Number.isFinite(item.indexReturn)).map(item => ({ time: item.timestamp, value: item.indexReturn })))
  pointByTime = new Map(source.map(item => [item.timestamp, item]))
}

async function refreshIntraday() {
  if (period.value !== '1d' || intradayPolling) return
  intradayPolling = true
  try {
    const points = normalizeTimeShare(await fetchTimeShareData(props.fundCode))
    if (period.value !== '1d') return
    chartData.value = points
    if (chart) syncChartData()
    else if (points.length >= 2) {
      await nextTick()
      createPerformanceChart()
    }
  } finally {
    intradayPolling = false
  }
}

function startIntradayPolling() {
  stopIntradayPolling()
  if (period.value !== '1d') return
  intradayTimer = setInterval(() => { void refreshIntraday() }, 1_000)
}

function createPerformanceChart() {
  disposeChart()
  const container = chartElement.value
  if (!container || chartData.value.length < 2) return

  const styles = getComputedStyle(container)
  const background = styles.getPropertyValue('--bg-secondary').trim() || '#080f21'
  const textColor = styles.getPropertyValue('--text-secondary').trim() || '#8c97aa'
  const borderColor = styles.getPropertyValue('--border-color').trim() || '#202a3c'

  chart = createChart(container, {
    width: container.clientWidth,
    height: 224,
    layout: { background: { type: ColorType.Solid, color: background }, textColor, fontSize: 10, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: borderColor } },
    leftPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
    rightPriceScale: { visible: false },
    timeScale: {
      borderVisible: false,
      rightOffset: 0,
      barSpacing: period.value === '1d' ? 4 : 6,
      minBarSpacing: 0.5,
      timeVisible: true,
      secondsVisible: period.value === '1d',
      tickMarkFormatter: time => {
        const date = new Date(Number(time as UTCTimestamp) * 1000)
        const pad = (value: number) => String(value).padStart(2, '0')
        return period.value === '1d'
          ? `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
          : `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
      }
    },
    localization: { priceFormatter: value => `${value.toFixed(2)}%` },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#64748b', labelVisible: false },
      horzLine: { color: '#64748b', labelVisible: false }
    },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: false }
  })

  fundSeries = chart.addSeries(AreaSeries, {
    priceScaleId: 'left',
    lineColor: fundLineColor.value,
    lineWidth: 2,
    topColor: fundFillColor.value,
    bottomColor: 'rgba(14, 203, 129, .01)',
    priceLineVisible: false,
    lastValueVisible: false,
    visible: seriesVisible.value.fund
  })
  averageSeries = chart.addSeries(LineSeries, {
    priceScaleId: 'left',
    color: '#31a7ba',
    lineWidth: 1,
    lineStyle: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    visible: seriesVisible.value.average
  })
  indexSeries = chart.addSeries(LineSeries, {
    priceScaleId: 'left',
    color: '#7d899d',
    lineWidth: 1,
    lineStyle: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    visible: seriesVisible.value.index
  })

  const source = chartData.value
  fundSeries.setData(source.map(item => ({ time: item.timestamp, value: item.fundReturn })))
  averageSeries.setData(source.filter(item => Number.isFinite(item.avgReturn)).map(item => ({ time: item.timestamp, value: item.avgReturn })))
  indexSeries.setData(source.filter(item => Number.isFinite(item.indexReturn)).map(item => ({ time: item.timestamp, value: item.indexReturn })))
  pointByTime = new Map(source.map(item => [item.timestamp, item]))
  chart.timeScale().fitContent()
  chart.subscribeCrosshairMove(event => {
    activePoint.value = typeof event.time === 'number' ? pointByTime.get(event.time) ?? null : null
  })

  resizeObserver = new ResizeObserver(() => {
    if (chart && container.clientWidth > 0) chart.applyOptions({ width: container.clientWidth })
  })
  resizeObserver.observe(container)
}

async function loadData() {
  const id = ++requestId
  loading.value = true
  loadError.value = ''
  activePoint.value = null
  disposeChart()
  try {
    const historyPromise = history.value.length
      ? Promise.resolve(history.value)
      : fetchNetValueHistoryFast(props.fundCode, 500)
    const [comparison, navHistory] = await Promise.all([
      period.value === '1d'
        ? fetchTimeShareData(props.fundCode).then(normalizeTimeShare)
        : fetchAccumulatedReturn(props.fundCode, selectedPeriod.value.range).then(normalizeData),
      historyPromise
    ])
    if (id !== requestId) return
    history.value = navHistory
    chartData.value = comparison
    if (period.value !== '1d' && chartData.value.length < 2) chartData.value = fallbackFromHistory(navHistory)
  } catch (error) {
    if (id !== requestId) return
    chartData.value = []
    loadError.value = error instanceof Error ? error.message : '业绩数据加载失败'
  } finally {
    if (id === requestId) {
      loading.value = false
      await nextTick()
      createPerformanceChart()
      startIntradayPolling()
    }
  }
}

function selectPeriod(value: PerformancePeriod) {
  if (period.value === value) return
  period.value = value
}

function toggleSeries(key: SeriesKey) {
  seriesVisible.value[key] = !seriesVisible.value[key]
  const target = key === 'fund' ? fundSeries : key === 'average' ? averageSeries : indexSeries
  target?.applyOptions({ visible: seriesVisible.value[key] })
}

function loadMoreHistory() {
  visibleHistoryCount.value = Math.min(visibleHistoryCount.value + 10, history.value.length)
}

watch([() => props.fundCode, period], () => {
  stopIntradayPolling()
  if (props.fundCode) void loadData()
}, { immediate: true })
watch(() => props.fundCode, () => {
  history.value = []
  visibleHistoryCount.value = 5
})
onBeforeUnmount(() => {
  stopIntradayPolling()
  disposeChart()
})
</script>

<template>
  <section class="performance-panel" aria-label="业绩走势">
    <div class="performance-summary">
      <span>{{ selectedPeriod.label }}{{ period === '1d' ? '估值' : '涨跌幅' }}</span>
      <strong :class="tone(latestPoint?.fundReturn)">{{ formatPercent(latestPoint?.fundReturn) }}</strong>
    </div>

    <div :class="['performance-legend', { intraday: period === '1d' }]" aria-label="图表图例">
      <button
        v-for="item in legendItems"
        :key="item.key"
        type="button"
        :class="{ muted: !seriesVisible[item.key] }"
        :aria-pressed="seriesVisible[item.key]"
        @click="toggleSeries(item.key)"
      >
        <span><i :style="{ background: item.color }" />{{ item.label }} <van-icon :name="seriesVisible[item.key] ? 'eye-o' : 'closed-eye'" /></span>
        <b :class="tone(item.value)">{{ formatPercent(item.value) }}</b>
      </button>
    </div>

    <div v-if="loading" class="performance-state"><van-loading size="18" /> 加载业绩走势</div>
    <div v-else-if="loadError" class="performance-state performance-error"><span>{{ loadError }}</span><button type="button" @click="loadData">重试</button></div>
    <div v-else-if="chartData.length < 2" class="performance-state">当前区间暂无可用数据</div>
    <div v-else class="performance-chart-wrap">
      <div ref="chartElement" class="performance-chart" />
      <time v-if="activePoint" class="active-date">{{ activePoint.date }}</time>
    </div>

    <div class="performance-periods" role="tablist" aria-label="业绩走势区间">
      <button
        v-for="item in periods"
        :key="item.value"
        type="button"
        :class="{ active: period === item.value }"
        :aria-selected="period === item.value"
        @click="selectPeriod(item.value)"
      >{{ item.label }}</button>
    </div>

    <div class="nav-history" aria-label="历史净值">
      <div class="nav-history-row nav-history-head"><span>日期</span><span>单位净值</span><span>累计净值</span><span>日涨幅</span></div>
      <div v-for="item in visibleHistory" :key="item.date" class="nav-history-row">
        <time>{{ item.date }}</time>
        <span>{{ item.netValue.toFixed(4) }}</span>
        <span>{{ (item.totalValue > 0 ? item.totalValue : item.netValue).toFixed(4) }}</span>
        <strong :class="tone(item.changeRate)">{{ formatPercent(item.changeRate) }}</strong>
      </div>
      <div v-if="!history.length && !loading" class="nav-history-empty">暂无历史净值</div>
    </div>
    <button v-if="canLoadMore" type="button" class="load-more" @click="loadMoreHistory">加载更多历史净值</button>
  </section>
</template>

<style scoped>
.performance-panel { min-width: 0; }
.performance-summary { display: flex; align-items: baseline; justify-content: flex-end; gap: 8px; min-height: 30px; padding: 0 4px; }
.performance-summary span { color: var(--text-secondary); font-size: 14px; }
.performance-summary strong { font-size: 16px; font-variant-numeric: tabular-nums; }
.performance-legend { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 4px 0 2px; }
.performance-legend.intraday { grid-template-columns: 1fr; }
.performance-legend.intraday button { text-align: left; }
.performance-legend button { display: grid; min-width: 0; gap: 5px; padding: 8px 4px; border: 0; color: var(--text-secondary); background: transparent; font-size: 11px; text-align: left; cursor: pointer; }
.performance-legend button:nth-child(2) { text-align: center; }
.performance-legend button:nth-child(3) { text-align: right; }
.performance-legend button > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.performance-legend i { display: inline-block; width: 10px; height: 2px; margin-right: 5px; vertical-align: middle; }
.performance-legend :deep(.van-icon) { margin-left: 2px; font-size: 11px; vertical-align: -1px; }
.performance-legend b { color: var(--text-secondary); font-size: 10px; font-weight: 500; font-variant-numeric: tabular-nums; }
.performance-legend .muted { opacity: .42; }
.performance-state { display: flex; height: 224px; align-items: center; justify-content: center; gap: 8px; color: var(--text-secondary); font-size: 12px; }
.performance-error button { border: 0; color: var(--color-primary); background: transparent; cursor: pointer; }
.performance-chart-wrap { position: relative; }
.performance-chart { width: 100%; height: 224px; --bg-secondary: var(--bg-secondary); }
.active-date { position: absolute; top: 4px; left: 50%; padding: 2px 6px; border-radius: 3px; color: var(--text-secondary); background: color-mix(in srgb, var(--bg-secondary) 88%, transparent); font-size: 10px; transform: translateX(-50%); }
.performance-periods { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; margin: 6px 0 8px; padding: 3px; border-radius: 6px; background: var(--bg-primary); }
.performance-periods button { min-width: 0; height: 30px; padding: 0 2px; border: 0; border-radius: 5px; color: var(--text-secondary); background: transparent; font-size: 12px; white-space: nowrap; cursor: pointer; }
.performance-periods button.active { color: var(--color-primary); background: color-mix(in srgb, var(--text-secondary) 20%, transparent); font-weight: 650; }
.nav-history { margin: 0; border: 1px solid var(--border-color); border-radius: 7px; overflow: hidden; }
.nav-history-row { display: grid; grid-template-columns: 1.25fr 1fr 1fr .9fr; min-height: 38px; align-items: center; border-bottom: 1px solid var(--border-color); font-size: 12px; font-variant-numeric: tabular-nums; }
.nav-history-row:last-child { border-bottom: 0; }
.nav-history-row > * { min-width: 0; padding: 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-history-row > *:not(:first-child) { text-align: right; }
.nav-history-head { min-height: 38px; color: var(--text-secondary); background: color-mix(in srgb, var(--bg-tertiary) 72%, var(--bg-secondary)); font-weight: 650; }
.nav-history-row strong { font-weight: 500; }
.nav-history-empty { padding: 28px 12px; color: var(--text-secondary); font-size: 12px; text-align: center; }
.load-more { display: block; margin: 0 auto; padding: 11px 18px 3px; border: 0; color: var(--text-secondary); background: transparent; font-size: 12px; cursor: pointer; }
.up { color: var(--color-up) !important; }
.down { color: var(--color-down) !important; }

@media (max-width: 430px) {
  .performance-summary { padding: 0; }
  .performance-legend button { font-size: 10px; }
  .nav-history-row > * { padding: 0 8px; }
  .performance-periods button { font-size: 11px; }
}
</style>
