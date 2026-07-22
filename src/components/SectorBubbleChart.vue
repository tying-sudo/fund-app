<script setup lang="ts">
import { forceCollide, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MarketIndex, MarketSector, MarketSectorType } from '@/api/market'

type BubbleNode = MarketSector & {
  radius: number
  x: number
  y: number
  vx?: number
  vy?: number
}

const props = defineProps<{
  sectors: MarketSector[]
  type: MarketSectorType
  updatedAt: string | null
  index: MarketIndex | null
  loading?: boolean
  error?: string
}>()

const emit = defineEmits<{
  close: []
  select: [sector: MarketSector]
  'type-change': [type: MarketSectorType]
}>()

const plotElement = ref<HTMLDivElement | null>(null)
const nodes = ref<BubbleNode[]>([])
const animationKey = ref(0)
const flowMotion = ref<Record<string, 'grow' | 'shrink'>>({})
let resizeObserver: ResizeObserver | null = null
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
let motionTimer: ReturnType<typeof setTimeout> | null = null
const previousFlowByCode = new Map<string, number>()

const typeLabel = computed(() => props.type === 'industry' ? '申万三级行业' : '东财概念')
const dateLabel = computed(() => {
  if (!props.updatedAt) return '实时'
  const date = new Date(props.updatedAt)
  if (Number.isNaN(date.getTime())) return '实时'
  return `${date.getMonth() + 1}月${date.getDate()}日`
})

const indexSummary = computed(() => {
  const index = props.index
  if (!index) return '板块资金流向分布'
  const change = Number.isFinite(index.changePercent) ? `${index.changePercent > 0 ? '+' : ''}${index.changePercent.toFixed(2)}%` : '--'
  return `${index.name} ${Number.isFinite(index.price) ? index.price.toFixed(2) : '--'} ${change}`
})

function flowText(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  return `${value > 0 ? '+' : ''}${(value / 100000000).toFixed(1)}亿`
}

function nodeStyle(node: BubbleNode, index: number) {
  const diameter = node.radius * 2
  return {
    width: `${diameter}px`,
    height: `${diameter}px`,
    '--bubble-transform': `translate3d(${node.x - node.radius}px, ${node.y - node.radius}px, 0)`,
    '--bubble-delay': `${Math.min(index * 26, 520)}ms`
  }
}

function nodeMotion(node: BubbleNode) {
  return flowMotion.value[node.code] || ''
}

function selectVisibleSectors(source: MarketSector[]) {
  const usable = source.filter(sector => Number.isFinite(sector.netInflow) && Math.abs(sector.netInflow || 0) > 0)
  const inflows = usable.filter(sector => (sector.netInflow || 0) > 0).sort((left, right) => (right.netInflow || 0) - (left.netInflow || 0)).slice(0, 6)
  const outflows = usable.filter(sector => (sector.netInflow || 0) < 0).sort((left, right) => (left.netInflow || 0) - (right.netInflow || 0)).slice(0, 24)
  return [...inflows, ...outflows]
}

function rebuildLayout() {
  const plot = plotElement.value
  if (!plot) return
  const width = plot.clientWidth
  const height = plot.clientHeight
  if (width < 80 || height < 160) return

  const visible = selectVisibleSectors(props.sectors)
  const maxFlow = Math.max(...visible.map(sector => Math.abs(sector.netInflow || 0)), 1)
  const maxRadius = Math.min(width * 0.145, 62)
  const minRadius = Math.max(19, Math.min(width * 0.06, 27))
  const positiveTarget = height * 0.24
  const negativeTarget = height * 0.69
  const next = visible.map((sector, index): BubbleNode => {
    const magnitude = Math.sqrt(Math.abs(sector.netInflow || 0) / maxFlow)
    const radius = minRadius + (maxRadius - minRadius) * magnitude
    const incoming = (sector.netInflow || 0) > 0
    return {
      ...sector,
      radius,
      x: width * (0.2 + ((index * 0.618) % 0.6)),
      y: incoming ? positiveTarget : negativeTarget,
      vx: 0,
      vy: 0
    }
  })

  const simulation = forceSimulation(next)
    .force('charge', forceManyBody().strength(-12))
    .force('x', forceX<BubbleNode>(width / 2).strength(0.035))
    .force('y', forceY<BubbleNode>(node => (node.netInflow || 0) > 0 ? positiveTarget : negativeTarget).strength(0.085))
    .force('collide', forceCollide<BubbleNode>(node => node.radius + 3).iterations(3))
    .stop()

  for (let tick = 0; tick < 260; tick += 1) simulation.tick()
  const nextMotion: Record<string, 'grow' | 'shrink'> = {}
  next.forEach(node => {
    const current = Math.abs(node.netInflow || 0)
    const previous = previousFlowByCode.get(node.code)
    if (previous !== undefined && current !== previous) nextMotion[node.code] = current > previous ? 'grow' : 'shrink'
    previousFlowByCode.set(node.code, current)
  })
  nodes.value = next.map(node => ({
    ...node,
    x: Math.max(node.radius + 3, Math.min(width - node.radius - 3, node.x)),
    y: Math.max(node.radius + 3, Math.min(height - node.radius - 3, node.y))
  }))
  if (Object.keys(nextMotion).length) {
    flowMotion.value = nextMotion
    if (motionTimer) clearTimeout(motionTimer)
    motionTimer = setTimeout(() => { flowMotion.value = {} }, 900)
  }
  animationKey.value += 1
}

function scheduleLayout() {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    rebuildLayout()
  }, 0)
}

watch(() => [props.sectors, props.type] as const, async () => {
  await nextTick()
  scheduleLayout()
}, { deep: true })

onMounted(() => {
  scheduleLayout()
  resizeObserver = new ResizeObserver(scheduleLayout)
  if (plotElement.value) resizeObserver.observe(plotElement.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (rebuildTimer) clearTimeout(rebuildTimer)
  if (motionTimer) clearTimeout(motionTimer)
})
</script>

<template>
  <section class="sector-bubble-chart" aria-label="实时板块资金流向气泡图">
    <header class="bubble-header">
      <div>
        <h2>资金净流入 - {{ dateLabel }}</h2>
        <p>实时板块资金流向追踪</p>
      </div>
      <div class="bubble-header-actions">
        <div class="bubble-type-switch" role="tablist" aria-label="板块类别">
          <button type="button" :class="{ active: type === 'industry' }" @click="emit('type-change', 'industry')">行业</button>
          <button type="button" :class="{ active: type === 'concept' }" @click="emit('type-change', 'concept')">概念</button>
        </div>
        <button class="bubble-close" type="button" aria-label="关闭气泡图" @click="emit('close')">×</button>
      </div>
    </header>

    <div ref="plotElement" class="bubble-plot" :class="{ loading }">
      <div class="plot-guideline" />
      <div class="plot-index-summary">{{ indexSummary }}</div>
      <div class="plot-caption">{{ typeLabel }}资金流向分布</div>
      <div v-if="loading" class="bubble-status">正在读取后端行情缓存...</div>
      <div v-else-if="error" class="bubble-status error">{{ error }}</div>
      <div v-else-if="!nodes.length" class="bubble-status">暂无可用的板块资金数据</div>
      <button
        v-for="(node, index) in nodes"
        :key="node.code"
        type="button"
        :class="['flow-bubble', (node.netInflow || 0) > 0 ? 'inflow' : 'outflow', nodeMotion(node)]"
        :style="nodeStyle(node, index)"
        :aria-label="`${node.name} ${flowText(node.netInflow)}`"
        @click="emit('select', node)"
      >
        <strong>{{ flowText(node.netInflow) }}</strong>
        <span>{{ node.name }}</span>
      </button>
    </div>
    <footer class="bubble-legend"><span class="inflow-dot" /> 流入 <span class="outflow-dot" /> 流出 <small>气泡面积按资金净额计算</small></footer>
  </section>
</template>

<style scoped>
.sector-bubble-chart { overflow: hidden; color: #eaf7f4; background: #102326; }
.bubble-header { display: flex; min-height: 62px; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px 8px 16px; border-bottom: 1px solid rgba(204, 239, 231, .14); }
.bubble-header h2 { margin: 0; font-size: 16px; line-height: 22px; font-weight: 650; }.bubble-header p { margin: 2px 0 0; color: #8eaaa5; font-size: 11px; }
.bubble-header-actions { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; }.bubble-type-switch { display: inline-flex; overflow: hidden; padding: 2px; border: 1px solid rgba(203, 238, 230, .18); border-radius: 4px; }.bubble-type-switch button { height: 24px; padding: 0 7px; border: 0; border-radius: 3px; color: #a7c1bc; background: transparent; font-size: 10px; cursor: pointer; }.bubble-type-switch button.active { color: #06201e; background: #91e9dd; font-weight: 650; }.bubble-close { display: grid; width: 30px; height: 30px; place-items: center; padding: 0; border: 0; border-radius: 50%; color: #eaf7f4; background: rgba(234, 247, 244, .14); font-size: 25px; line-height: 1; cursor: pointer; }
.bubble-plot { position: relative; height: min(560px, calc(100vh - 130px)); min-height: 420px; overflow: hidden; background-color: #102326; background-image: radial-gradient(rgba(167, 228, 217, .18) 1px, transparent 1px); background-size: 17px 17px; isolation: isolate; }.bubble-plot::before { position: absolute; z-index: -1; top: 0; right: 0; left: 0; height: 48%; content: ''; background: linear-gradient(180deg, rgba(167, 37, 51, .16), transparent); }.bubble-plot::after { position: absolute; z-index: -1; right: 0; bottom: 0; left: 0; height: 57%; content: ''; background: linear-gradient(0deg, rgba(6, 138, 104, .22), transparent); }
.plot-guideline { position: absolute; z-index: 1; top: 43%; right: 18px; left: 18px; border-top: 1px dashed rgba(185, 226, 218, .3); }.plot-index-summary { position: absolute; z-index: 2; top: calc(43% - 17px); width: 100%; color: #81d9c7; font-size: 12px; font-variant-numeric: tabular-nums; text-align: center; }.plot-caption { position: absolute; z-index: 2; top: calc(43% + 5px); width: 100%; color: #8eaaa5; font-size: 11px; text-align: center; }
.flow-bubble { position: absolute; display: flex; align-items: center; justify-content: center; padding: 5px; border: 1px solid rgba(255, 255, 255, .4); border-radius: 50%; box-shadow: inset 0 2px 7px rgba(255, 255, 255, .28), 0 4px 12px rgba(0, 0, 0, .23); color: #fff; flex-direction: column; font-family: inherit; font-variant-numeric: tabular-nums; line-height: 1.12; cursor: pointer; transform: var(--bubble-transform); transform-origin: center; animation: bubble-arrive 680ms cubic-bezier(.16, 1, .3, 1) var(--bubble-delay) both; transition: transform 560ms cubic-bezier(.16, 1, .3, 1), width 560ms cubic-bezier(.16, 1, .3, 1), height 560ms cubic-bezier(.16, 1, .3, 1), filter 280ms ease; }.flow-bubble:active { filter: brightness(1.14); }.flow-bubble.grow { animation: bubble-grow 760ms ease-out; }.flow-bubble.shrink { animation: bubble-shrink 760ms ease-out; }.flow-bubble strong { max-width: 100%; overflow: hidden; font-size: clamp(10px, 2.9vw, 14px); text-overflow: ellipsis; white-space: nowrap; }.flow-bubble span { display: -webkit-box; max-width: 100%; margin-top: 3px; overflow: hidden; font-size: clamp(8px, 2.2vw, 10px); text-align: center; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }.flow-bubble.inflow { background: radial-gradient(circle at 34% 26%, #ff8a85, #ef4444 56%, #ba2835); }.flow-bubble.outflow { background: radial-gradient(circle at 34% 26%, #53d99c, #0aaf70 56%, #05704f); }
.bubble-status { position: absolute; z-index: 4; top: 50%; right: 24px; left: 24px; color: #a8c5c0; font-size: 13px; text-align: center; transform: translateY(-50%); }.bubble-status.error { color: #ff9b9b; }.bubble-legend { display: flex; min-height: 38px; align-items: center; gap: 5px; padding: 0 14px; border-top: 1px solid rgba(204, 239, 231, .14); color: #b6cdc8; font-size: 11px; }.bubble-legend small { margin-left: auto; color: #789792; font-size: 10px; }.inflow-dot, .outflow-dot { width: 8px; height: 8px; margin-left: 8px; border-radius: 50%; }.inflow-dot { margin-left: 0; background: #ef4444; }.outflow-dot { background: #0aaf70; }
@keyframes bubble-arrive { from { opacity: 0; transform: var(--bubble-transform) scale(0); } to { opacity: 1; transform: var(--bubble-transform) scale(1); } }
@keyframes bubble-grow { 0%, 100% { filter: brightness(1); } 40% { filter: brightness(1.32) saturate(1.2); } } @keyframes bubble-shrink { 0%, 100% { filter: brightness(1); } 40% { filter: brightness(.73) saturate(.75); } }
@media (min-width: 641px) { .bubble-header { padding-right: 18px; padding-left: 20px; }.bubble-header h2 { font-size: 18px; } }
@media (max-width: 380px) { .bubble-plot { min-height: 400px; }.bubble-header h2 { font-size: 14px; }.bubble-header p { display: none; }.bubble-legend small { display: none; } }
</style>
