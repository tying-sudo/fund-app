<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from 'lightweight-charts'
import { fetchTimeShareData, type TimeShareData } from '@/api/fund'
import { fetchSimpleKLineData, type SimpleKLineData } from '@/api/fundFast'
import { getBeijingDateString } from '@/utils/tradingDate'

export type FundTrendPeriod = '1d' | '1m' | '3m' | '1y'

interface FundTrendPoint {
  time: string
  value: number
  change: number | null
}

interface FundTrendStats {
  high: number
  low: number
  change: number | null
}

const props = defineProps<{
  fundCode: string
  name: string
  realtimeValue: number
  realtimeChange: number
}>()

const emit = defineEmits<{
  (event: 'period-change', period: FundTrendPeriod): void
  (event: 'stats-update', stats: FundTrendStats): void
}>()

const periods: Array<{ value: FundTrendPeriod; label: string; days: number }> = [
  { value: '1d', label: '分时', days: 0 },
  { value: '1m', label: '1月', days: 35 },
  { value: '3m', label: '3月', days: 110 },
  { value: '1y', label: '1年', days: 400 }
]

const period = ref<FundTrendPeriod>('1d')
const points = ref<FundTrendPoint[]>([])
const loading = ref(true)
const loadError = ref('')
const activePoint = ref<FundTrendPoint | null>(null)
const periodChange = ref<number | null>(null)
const chartElement = ref<HTMLDivElement | null>(null)
let chart: IChartApi | null = null
let priceSeries: ISeriesApi<'Line'> | null = null
let changeSeries: ISeriesApi<'Histogram'> | null = null
let resizeObserver: ResizeObserver | null = null
let pointByTime = new Map<number, FundTrendPoint>()
let requestId = 0

const displayPoint = computed(() => activePoint.value ?? points.value.at(-1) ?? null)
const displayPeriod = computed(() => periods.find(item => item.value === period.value)?.label ?? '')

function chartTime(value: string): UTCTimestamp | null {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::\d{2})?)?$/)
  if (!matched) return null
  const [, year, month, day, hour = '0', minute = '0'] = matched
  return Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) / 1000) as UTCTimestamp
}

function formatValue(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? '--' : value.toFixed(4)
}

function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? '--' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function tone(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return 'flat'
  return value > 0 ? 'up' : 'down'
}

function normalizeTimeShare(items: TimeShareData[]): FundTrendPoint[] {
  const date = getBeijingDateString()
  return cleanPoints(items
    .map(item => ({
      time: /^\d{4}-\d{2}-\d{2}/.test(item.time) ? item.time : `${date} ${item.time.slice(0, 5)}`,
      value: Number(item.value),
      change: Number.isFinite(Number(item.change)) ? Number(item.change) : null
    }))
    .filter(item => Number.isFinite(item.value)))
}

function normalizeHistory(items: SimpleKLineData[]): FundTrendPoint[] {
  return cleanPoints(items
    .map(item => ({ time: item.time, value: Number(item.value), change: Number.isFinite(Number(item.change)) ? Number(item.change) : null }))
    .filter(item => Number.isFinite(item.value)))
}

function cleanPoints(items: FundTrendPoint[]) {
  const byTime = new Map(items.map(item => [item.time, item]))
  return [...byTime.values()].sort((left, right) => left.time.localeCompare(right.time))
}

function applyRealtimePoint(source: FundTrendPoint[]) {
  if (period.value !== '1d' || !Number.isFinite(props.realtimeValue) || props.realtimeValue <= 0) return source
  const date = getBeijingDateString()
  const now = new Date()
  const time = `${date} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const change = Number.isFinite(props.realtimeChange) ? props.realtimeChange : null
  const result = [...source]
  const last = result.at(-1)
  if (last?.time === time) result[result.length - 1] = { time, value: props.realtimeValue, change }
  else result.push({ time, value: props.realtimeValue, change })
  return cleanPoints(result)
}

function disposeChart() {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.remove()
  chart = null
  priceSeries = null
  changeSeries = null
  activePoint.value = null
  pointByTime = new Map()
}

function updateStats(source: FundTrendPoint[]) {
  const values = source.map(item => item.value).filter(Number.isFinite)
  const first = values[0]
  const last = values.at(-1)
  periodChange.value = first && last && first > 0 ? ((last - first) / first) * 100 : null
  if (values.length) {
    emit('stats-update', {
      high: Math.max(...values),
      low: Math.min(...values),
      change: periodChange.value
    })
  }
}

function createTrendChart() {
  disposeChart()
  const container = chartElement.value
  const source = points.value
    .map(point => ({ point, time: chartTime(point.time) }))
    .filter((item): item is { point: FundTrendPoint; time: UTCTimestamp } => item.time !== null && Number.isFinite(item.point.value))
  if (!container || source.length < 2) return

  const styles = getComputedStyle(container)
  const background = styles.getPropertyValue('--bg-primary').trim() || '#ffffff'
  const textColor = styles.getPropertyValue('--text-secondary').trim() || '#64748b'
  const borderColor = styles.getPropertyValue('--border-color').trim() || '#e2e8f0'
  const first = source[0].point.value
  const last = source.at(-1)?.point.value ?? first
  const lineColor = last >= first ? '#ef4444' : '#10b981'
  pointByTime = new Map(source.map(item => [item.time, item.point]))

  chart = createChart(container, {
    width: container.clientWidth,
    height: 224,
    layout: { background: { type: ColorType.Solid, color: background }, textColor, attributionLogo: false },
    grid: { vertLines: { color: borderColor }, horzLines: { color: borderColor } },
    rightPriceScale: { borderColor, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderColor, timeVisible: period.value === '1d', secondsVisible: false, rightOffset: 2, barSpacing: period.value === '1d' ? 4 : 8 },
    crosshair: { mode: CrosshairMode.Normal },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true }
  })
  chart.addPane()
  chart.panes()[0].setStretchFactor(3)
  chart.panes()[1].setStretchFactor(1)
  priceSeries = chart.addSeries(LineSeries, { color: lineColor, lineWidth: 2, lastValueVisible: true, priceLineVisible: false }, 0)
  changeSeries = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, base: 0 }, 1)
  priceSeries.setData(source.map(item => ({ time: item.time, value: item.point.value })))
  changeSeries.setData(source
    .filter(item => item.point.change !== null && Number.isFinite(item.point.change))
    .map(item => ({ time: item.time, value: item.point.change as number, color: (item.point.change as number) >= 0 ? '#ef4444' : '#10b981' })))
  chart.timeScale().fitContent()
  chart.subscribeCrosshairMove(event => {
    const time = typeof event.time === 'number' ? event.time : null
    activePoint.value = time === null ? null : pointByTime.get(time) ?? null
  })
  resizeObserver = new ResizeObserver(() => {
    if (chart && container.clientWidth > 0) chart.applyOptions({ width: container.clientWidth })
  })
  resizeObserver.observe(container)
}

async function loadTrend() {
  const id = ++requestId
  disposeChart()
  loading.value = true
  loadError.value = ''
  periodChange.value = null
  try {
    const selected = periods.find(item => item.value === period.value)!
    const loaded = period.value === '1d'
      ? normalizeTimeShare(await fetchTimeShareData(props.fundCode))
      : normalizeHistory(await fetchSimpleKLineData(props.fundCode, selected.days))
    if (id !== requestId) return
    points.value = applyRealtimePoint(loaded)
    updateStats(points.value)
  } catch (error) {
    if (id !== requestId) return
    points.value = []
    loadError.value = error instanceof Error ? error.message : '走势数据加载失败'
  } finally {
    if (id === requestId) {
      loading.value = false
      await nextTick()
      createTrendChart()
    }
  }
}

function selectPeriod(next: FundTrendPeriod) {
  if (next === period.value) return
  period.value = next
  emit('period-change', next)
}

watch([() => props.fundCode, period], loadTrend, { immediate: true })
watch(() => [props.realtimeValue, props.realtimeChange] as const, async () => {
  if (period.value !== '1d' || !points.value.length) return
  points.value = applyRealtimePoint(points.value)
  updateStats(points.value)
  await nextTick()
  createTrendChart()
})
onMounted(() => { if (points.value.length) createTrendChart() })
onBeforeUnmount(disposeChart)
</script>

<template>
  <section class="fund-trend" aria-label="分时估值走势">
    <div class="valuation-summary">
      <span>{{ displayPeriod }}{{ period === '1d' ? '估值' : '净值' }}</span>
      <strong :class="tone(period === '1d' ? props.realtimeChange : periodChange)">{{ period === '1d' ? formatPercent(props.realtimeChange) : formatPercent(periodChange) }}</strong>
    </div>
    <div class="valuation-legend" aria-label="估值图例">
      <span><i class="value-line" />{{ period === '1d' ? '估算净值' : '单位净值' }} <b>{{ formatValue(displayPoint?.value) }}</b></span>
      <span><i class="change-line" />涨跌幅 <b :class="tone(displayPoint?.change)">{{ formatPercent(displayPoint?.change) }}</b></span>
    </div>
    <div v-if="loading" class="chart-state"><van-loading size="18" /> 更新走势</div>
    <div v-else-if="loadError" class="chart-state chart-error"><span>{{ loadError }}</span><button type="button" @click="loadTrend">重试</button></div>
    <div v-else-if="points.length < 2" class="chart-state">当前周期暂无可用走势数据</div>
    <div v-else class="chart-wrap">
      <div ref="chartElement" class="chart-canvas" />
      <div v-if="activePoint" class="chart-tooltip" aria-live="polite">
        <span>{{ activePoint.time }}</span>
        <strong>净值 {{ formatValue(activePoint.value) }}</strong>
        <strong :class="tone(activePoint.change)">涨跌幅 {{ formatPercent(activePoint.change) }}</strong>
      </div>
    </div>
    <div class="period-tabs" role="tablist" aria-label="估值走势周期">
      <button v-for="item in periods" :key="item.value" type="button" :class="{ active: period === item.value }" :aria-selected="period === item.value" @click="selectPeriod(item.value)">{{ item.label }}</button>
    </div>
  </section>
</template>

<style scoped>
.fund-trend { min-width: 0; }
.valuation-summary { display: flex; align-items: baseline; justify-content: flex-end; gap: 8px; min-height: 28px; }
.valuation-summary span { color: var(--text-secondary); font-size: 13px; }
.valuation-summary strong { font-size: 15px; font-variant-numeric: tabular-nums; }
.valuation-legend { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 8px 4px; color: var(--text-secondary); font-size: 11px; }
.valuation-legend span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.valuation-legend span:last-child { text-align: right; }
.valuation-legend i { display: inline-block; width: 10px; height: 2px; margin-right: 5px; vertical-align: middle; }
.value-line { background: #22d3a6; }
.change-line { background: #7d899d; }
.valuation-legend b { margin-left: 3px; color: var(--text-primary); font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; }
.period-tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2px; margin-top: 6px; padding: 3px; border-radius: 6px; background: var(--bg-primary); }
.period-tabs button { height: 30px; min-width: 0; border: 0; border-radius: 5px; color: var(--text-secondary); background: transparent; font-size: 12px; cursor: pointer; }
.period-tabs button.active { color: var(--color-primary); background: color-mix(in srgb, var(--text-secondary) 20%, transparent); font-weight: 650; }
.chart-state { display: grid; min-height: 224px; place-items: center; align-content: center; gap: 8px; color: var(--text-secondary); font-size: 12px; text-align: center; }.chart-error { color: var(--color-down); }.chart-error button { min-width: 64px; height: 30px; border: 0; border-radius: 4px; color: #fff; background: var(--color-primary); cursor: pointer; }.chart-wrap { position: relative; min-height: 224px; user-select: none; }.chart-canvas { width: 100%; height: 224px; touch-action: pan-y; }.chart-tooltip { position: absolute; z-index: 2; top: 8px; left: 8px; display: grid; gap: 2px; min-width: 142px; padding: 7px 9px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); background: color-mix(in srgb, var(--bg-primary) 94%, transparent); box-shadow: 0 2px 8px rgba(0, 0, 0, .08); font-size: 11px; line-height: 16px; pointer-events: none; }.chart-tooltip > span { color: var(--text-secondary); }.chart-tooltip strong { font-weight: 600; font-variant-numeric: tabular-nums; }.up { color: var(--color-up) !important; }.down { color: var(--color-down) !important; }.flat { color: var(--text-secondary) !important; }
</style>
