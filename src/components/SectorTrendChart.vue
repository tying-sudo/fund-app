<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import type { SectorDetailPeriod, SectorTrendPoint } from '@/api/market'

const props = defineProps<{
  name: string
  period: SectorDetailPeriod
  points: SectorTrendPoint[]
}>()

const chartElement = ref<HTMLDivElement | null>(null)
const activePoint = ref<SectorTrendPoint | null>(null)
let chart: IChartApi | null = null
let pointSeries: ISeriesApi<'Line'> | null = null
let fundFlowSeries: ISeriesApi<'Histogram'> | null = null
let resizeObserver: ResizeObserver | null = null
let pointByTime = new Map<number, SectorTrendPoint>()

function chartTime(value: string): UTCTimestamp | null {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/)
  if (!matched) return null
  const [, year, month, day, hour = '0', minute = '0'] = matched
  return Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) / 1000) as UTCTimestamp
}

function formatPoint(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? '--' : value.toFixed(2)
}

function formatFlow(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  const unit = Math.abs(value) >= 100000000 ? 100000000 : 10000
  return `${value > 0 ? '+' : ''}${(value / unit).toFixed(2)}${unit === 100000000 ? '亿' : '万'}`
}

function flowClass(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return 'flat'
  return value > 0 ? 'up' : 'down'
}

function disposeChart() {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.remove()
  chart = null
  pointSeries = null
  fundFlowSeries = null
  activePoint.value = null
  pointByTime = new Map()
}

function createTrendChart() {
  disposeChart()
  const container = chartElement.value
  const source = props.points
    .map(point => ({ point, time: chartTime(point.time) }))
    .filter((item): item is { point: SectorTrendPoint; time: UTCTimestamp } => item.time !== null && Number.isFinite(item.point.value))

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
    height: 300,
    layout: { background: { type: ColorType.Solid, color: background }, textColor, attributionLogo: false },
    grid: { vertLines: { color: borderColor }, horzLines: { color: borderColor } },
    rightPriceScale: { borderColor, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: {
      borderColor,
      timeVisible: props.period === '1d',
      secondsVisible: false,
      rightOffset: 2,
      barSpacing: props.period === '1d' ? 4 : 8
    },
    crosshair: { mode: CrosshairMode.Normal },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true }
  })

  chart.addPane()
  chart.panes()[0].setStretchFactor(3)
  chart.panes()[1].setStretchFactor(1)
  pointSeries = chart.addSeries(LineSeries, { color: lineColor, lineWidth: 2, lastValueVisible: true, priceLineVisible: false }, 0)
  fundFlowSeries = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, base: 0 }, 1)
  pointSeries.setData(source.map(item => ({ time: item.time, value: item.point.value })))
  fundFlowSeries.setData(source
    .filter(item => item.point.netInflow !== null && Number.isFinite(item.point.netInflow))
    .map(item => ({
      time: item.time,
      value: item.point.netInflow as number,
      color: (item.point.netInflow as number) >= 0 ? '#ef4444' : '#10b981'
    })))
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

watch(() => [props.period, props.points] as const, async () => {
  await nextTick()
  createTrendChart()
}, { deep: true })

onMounted(createTrendChart)
onBeforeUnmount(disposeChart)
</script>

<template>
  <div class="sector-trend-chart" :aria-label="`${name}走势与资金流向`">
    <div ref="chartElement" class="chart-canvas" />
    <div class="chart-legend"><span>点位</span><span>主力资金净流入</span></div>
    <div v-if="activePoint" class="chart-tooltip" aria-live="polite">
      <span>{{ activePoint.time }}</span>
      <strong>点位 {{ formatPoint(activePoint.value) }}</strong>
      <strong :class="flowClass(activePoint.netInflow)">主力净流入 {{ formatFlow(activePoint.netInflow) }}</strong>
    </div>
  </div>
</template>

<style scoped>
.sector-trend-chart { position: relative; margin-top: 12px; min-height: 300px; user-select: none; }
.chart-canvas { width: 100%; height: 300px; touch-action: pan-y; }
.chart-legend { position: absolute; top: 8px; left: 8px; display: flex; gap: 12px; color: var(--text-secondary); font-size: 11px; pointer-events: none; }
.chart-legend span::before { display: inline-block; width: 7px; height: 7px; margin-right: 4px; border-radius: 50%; content: ''; background: #ef4444; }.chart-legend span:last-child::before { border-radius: 1px; background: #64748b; }
.chart-tooltip { position: absolute; z-index: 2; top: 30px; left: 8px; display: grid; gap: 2px; min-width: 148px; padding: 7px 9px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); background: color-mix(in srgb, var(--bg-primary) 94%, transparent); box-shadow: 0 2px 8px rgba(0, 0, 0, .08); font-size: 11px; line-height: 16px; pointer-events: none; }.chart-tooltip > span { color: var(--text-secondary); }.chart-tooltip strong { font-weight: 600; font-variant-numeric: tabular-nums; }.up { color: var(--color-up); }.down { color: var(--color-down); }.flat { color: var(--text-secondary); }
</style>
