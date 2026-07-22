<script setup lang="ts">
defineOptions({ name: 'Market' })

// Layout adapted for Vue from tying-sudo/tying-fund MarketTab (AGPL-3.0).
// Market quotes are fetched exclusively from fund-app's public proxy.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import MarketIndexBoard from '@/components/MarketIndexBoard.vue'
import SectorBubbleChart from '@/components/SectorBubbleChart.vue'
import SectorFlowTracker from '@/components/SectorFlowTracker.vue'
import { getBeijingDayAndMinutes } from '@/utils/tradingDate'
import {
  fetchAllMarketSectors,
  fetchMarketOverview,
  fetchMarketRanking,
  type MarketFundRank,
  type MarketIndex,
  type MarketOverview,
  type MarketRankTab,
  type MarketSector
  , type MarketSectorSort
  , type MarketSectorType
} from '@/api/market'

const router = useRouter()
const overview = ref<MarketOverview | null>(null)
const ranking = ref<MarketFundRank[]>([])
const isRefreshing = ref(false)
const snapshotLoading = ref(true)
const featuredSectorsLoading = ref(true)
const rankingLoading = ref(true)
const loadError = ref('')
const activeRankTab = ref<MarketRankTab>('increase')
const sectorFilter = ref<'all' | 'industry' | 'concept'>('industry')
const sectorSort = ref<'changePercent' | 'netInflow'>('changePercent')
const sectorSortOrder = ref<'asc' | 'desc'>('desc')
const sectorsExpanded = ref(false)
const allSectorsOpen = ref(false)
const allSectorType = ref<MarketSectorType>('industry')
const allSectorSort = ref<MarketSectorSort>('change')
const allSectorOrder = ref<'asc' | 'desc'>('desc')
const allSectors = ref<MarketSector[]>([])
const allSectorsLoading = ref(false)
const featuredSectors = ref<MarketSector[]>([])
const activeMarketTool = ref<'index' | 'bubble' | 'tracker'>('index')
const bubbleSectors = ref<MarketSector[]>([])
const bubbleSectorsLoading = ref(false)
const bubbleSectorsError = ref('')
const trackerSectors = ref<MarketSector[]>([])
const trackerSectorsLoading = ref(false)
const trackerSectorsError = ref('')
const indexManagerOpen = ref(false)
const INDEX_STORAGE_KEY = 'market:index-watchlist:v1'
const MAX_INDEX_COUNT = 6
const DEFAULT_INDEX_CODES = ['000001', '399001', '399006', 'HSTECH', '000300', '000688']
const INTRADAY_SECTOR_REFRESH_MS = 5_000
const indexOrder = ref<string[]>([...DEFAULT_INDEX_CODES])
const draggedIndexCode = ref<string | null>(null)

const rankTabs: Array<{ key: MarketRankTab; label: string }> = [
  { key: 'increase', label: '股票涨幅' },
  { key: 'decrease', label: '股票跌幅' },
  { key: 'hot', label: '混合基金' },
  { key: 'actual', label: '债券基金' }
]

const indices = computed<MarketIndex[]>(() => overview.value?.indices || [])
const visibleIndices = computed<MarketIndex[]>(() => {
  const byCode = new Map(indices.value.map(index => [index.code, index]))
  return indexOrder.value.map(code => byCode.get(code)).filter((index): index is MarketIndex => Boolean(index)).slice(0, MAX_INDEX_COUNT)
})
const availableIndices = computed(() => indices.value.filter(index => !indexOrder.value.includes(index.code)))
const sectors = computed<MarketSector[]>(() => featuredSectors.value)
const sectorUpdatedAt = computed(() => formatTime(sectors.value[0]?.updatedAt))
const bubbleIndex = computed<MarketIndex | null>(() => indices.value.find(index => index.code === '000001') || indices.value[0] || null)
const bubbleUpdatedAt = computed(() => bubbleSectors.value[0]?.updatedAt || null)

const filteredSectors = computed(() => {
  return sectors.value.slice(0, sectorsExpanded.value ? 24 : 12)
})

function formatTime(value: string | null | undefined) {
  if (!value) return '--'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function number(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? '--' : value.toFixed(digits)
}

function percent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function valueClass(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return 'flat'
  return value > 0 ? 'up' : 'down'
}

function formatFlow(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  const amount = value / 100000000
  return `${amount > 0 ? '+' : ''}${amount.toFixed(2)}亿`
}

function rankingDate(item: MarketFundRank) {
  return item.navDate ? item.navDate.slice(5) : '--'
}

function persistIndexOrder() {
  try {
    localStorage.setItem(INDEX_STORAGE_KEY, JSON.stringify(indexOrder.value))
  } catch {
    // Storage is optional; the default watchlist remains available.
  }
}

function loadIndexOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(INDEX_STORAGE_KEY) || '[]')
    if (Array.isArray(saved)) {
      const codes = saved.filter((code): code is string => typeof code === 'string')
      if (codes.length) indexOrder.value = [...new Set(codes)].slice(0, MAX_INDEX_COUNT)
    }
  } catch {
    indexOrder.value = [...DEFAULT_INDEX_CODES]
  }
}

function addIndex(code: string) {
  if (indexOrder.value.includes(code)) return
  if (indexOrder.value.length >= MAX_INDEX_COUNT) {
    showToast('最多显示 6 个指数')
    return
  }
  indexOrder.value.push(code)
  persistIndexOrder()
}

function removeIndex(code: string) {
  if (indexOrder.value.length <= 1) {
    showToast('至少保留 1 个指数')
    return
  }
  indexOrder.value = indexOrder.value.filter(item => item !== code)
  persistIndexOrder()
}

function moveIndexTo(sourceCode: string, targetCode: string) {
  if (sourceCode === targetCode) return
  const source = indexOrder.value.indexOf(sourceCode)
  const target = indexOrder.value.indexOf(targetCode)
  if (source < 0 || target < 0) return
  const next = [...indexOrder.value]
  next.splice(source, 1)
  next.splice(target, 0, sourceCode)
  indexOrder.value = next
  persistIndexOrder()
}

function startIndexDrag(code: string, event: DragEvent) {
  draggedIndexCode.value = code
  event.dataTransfer?.setData('text/plain', code)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function finishIndexDrag(targetCode: string) {
  const sourceCode = draggedIndexCode.value
  if (sourceCode) moveIndexTo(sourceCode, targetCode)
  draggedIndexCode.value = null
}

function startIndexPointerDrag(code: string, event: PointerEvent) {
  if (event.pointerType === 'mouse') return
  draggedIndexCode.value = code
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function moveIndexByPointer(event: PointerEvent) {
  const sourceCode = draggedIndexCode.value
  if (!sourceCode) return
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-index-code]')?.dataset.indexCode
  if (target) moveIndexTo(sourceCode, target)
}

function endIndexPointerDrag() {
  draggedIndexCode.value = null
}

function restoreDefaultIndices() {
  indexOrder.value = [...DEFAULT_INDEX_CODES]
  persistIndexOrder()
}

let snapshotRequestId = 0
async function loadSnapshot(silent = false) {
  const requestId = ++snapshotRequestId
  if (!silent) snapshotLoading.value = true
  try {
    const data = await fetchMarketOverview('gp')
    if (requestId === snapshotRequestId) overview.value = data
  } finally {
    if (requestId === snapshotRequestId) snapshotLoading.value = false
  }
}

let featuredRequestId = 0
async function loadFeaturedSectors(silent = false) {
  const requestId = ++featuredRequestId
  if (!silent) featuredSectorsLoading.value = true
  try {
    const type: MarketSectorType = sectorFilter.value === 'concept' ? 'concept' : 'industry'
    const sort: MarketSectorSort = sectorSort.value === 'netInflow' ? 'flow' : 'change'
    const data = await fetchAllMarketSectors(type, sort, sectorSortOrder.value, 24)
    if (requestId === featuredRequestId) featuredSectors.value = data
  } finally {
    if (requestId === featuredRequestId) featuredSectorsLoading.value = false
  }
}

let rankingRequestId = 0
async function loadRanking(silent = false) {
  const requestId = ++rankingRequestId
  if (!silent) rankingLoading.value = true
  try {
    const data = await fetchMarketRanking(activeRankTab.value)
    if (requestId === rankingRequestId) ranking.value = data
  } finally {
    if (requestId === rankingRequestId) rankingLoading.value = false
  }
}

async function loadMarket(silent = false) {
  if (!silent) loadError.value = ''
  const results = await Promise.allSettled([
    loadSnapshot(silent),
    loadFeaturedSectors(silent),
    loadRanking(silent)
  ])
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed.length === results.length) {
    const error = failed[0].reason
    loadError.value = error instanceof Error ? error.message : '行情数据加载失败'
  }
}

async function onRefresh() {
  isRefreshing.value = true
  await loadMarket()
  isRefreshing.value = false
  if (!loadError.value) showToast('行情已更新')
}

function selectSectorFilter(filter: 'all' | 'industry' | 'concept') {
  sectorFilter.value = filter
}

function selectSectorSort(sort: 'changePercent' | 'netInflow', order: 'asc' | 'desc') {
  sectorSort.value = sort
  sectorSortOrder.value = order
}

function isChinaMarketOpen() {
  const { day, minutes } = getBeijingDayAndMinutes()
  const weekday = day >= 1 && day <= 5
  return weekday && ((minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30) || (minutes >= 13 * 60 && minutes < 15 * 60))
}

function goToDetail(code: string) {
  router.push(`/detail/${code}`)
}

function goToSectorDetail(sector: MarketSector) {
  router.push({ name: 'sectorDetail', params: { code: sector.code }, query: { name: sector.name, type: sectorFilter.value } })
}

let bubbleRequestId = 0
async function loadBubbleSectors(silent = false) {
  const requestId = ++bubbleRequestId
  if (!silent) bubbleSectorsLoading.value = true
  bubbleSectorsError.value = ''
  try {
    const type: MarketSectorType = sectorFilter.value === 'concept' ? 'concept' : 'industry'
    const data = await fetchAllMarketSectors(type, 'flow', 'desc', 500)
    if (requestId === bubbleRequestId) bubbleSectors.value = data
  } catch (error) {
    if (requestId === bubbleRequestId) {
      bubbleSectorsError.value = error instanceof Error ? error.message : '板块资金数据加载失败'
    }
  } finally {
    if (requestId === bubbleRequestId && !silent) bubbleSectorsLoading.value = false
  }
}

function openSectorBubble() {
  activeMarketTool.value = 'bubble'
  loadBubbleSectors()
}

function selectBubbleSector(sector: MarketSector) {
  activeMarketTool.value = 'index'
  goToSectorDetail(sector)
}

let trackerRequestId = 0
async function loadTrackerSectors(silent = false) {
  const requestId = ++trackerRequestId
  if (!silent) trackerSectorsLoading.value = true
  trackerSectorsError.value = ''
  try {
    const type: MarketSectorType = sectorFilter.value === 'concept' ? 'concept' : 'industry'
    const data = await fetchAllMarketSectors(type, 'flow', 'desc', 500)
    if (requestId === trackerRequestId) trackerSectors.value = data
  } catch (error) {
    if (requestId === trackerRequestId) trackerSectorsError.value = error instanceof Error ? error.message : '板块资金数据加载失败'
  } finally {
    if (requestId === trackerRequestId && !silent) trackerSectorsLoading.value = false
  }
}

function openSectorTracker() {
  activeMarketTool.value = 'tracker'
  loadTrackerSectors()
}

function selectTrackedSector(sector: MarketSector) {
  activeMarketTool.value = 'index'
  goToSectorDetail(sector)
}

async function loadAllSectors() {
  allSectorsLoading.value = true
  try {
    allSectors.value = await fetchAllMarketSectors(allSectorType.value, allSectorSort.value, allSectorOrder.value)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '板块表加载失败')
  } finally {
    allSectorsLoading.value = false
  }
}

async function openAllSectors() {
  allSectorType.value = sectorFilter.value === 'concept' ? 'concept' : 'industry'
  allSectorSort.value = sectorSort.value === 'netInflow' ? 'flow' : 'change'
  allSectorOrder.value = sectorSortOrder.value
  allSectorsOpen.value = true
  await loadAllSectors()
}

function selectAllSectorSort(sort: MarketSectorSort, order: 'asc' | 'desc') {
  allSectorSort.value = sort
  allSectorOrder.value = order
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
let intradaySectorTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  loadIndexOrder()
  loadMarket()
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadMarket(true)
  }, 60_000)
  intradaySectorTimer = setInterval(() => {
    if (document.visibilityState !== 'visible' || !isChinaMarketOpen()) return
    if (activeMarketTool.value === 'bubble') loadBubbleSectors(true)
    if (activeMarketTool.value === 'tracker') loadTrackerSectors(true)
  }, INTRADAY_SECTOR_REFRESH_MS)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  if (intradaySectorTimer) clearInterval(intradaySectorTimer)
})

watch(activeRankTab, () => loadRanking())
watch([sectorFilter, sectorSort, sectorSortOrder], () => {
  sectorsExpanded.value = false
  loadFeaturedSectors().catch(error => showToast(error instanceof Error ? error.message : '板块加载失败'))
})
watch(sectorFilter, () => {
  if (activeMarketTool.value === 'bubble') loadBubbleSectors()
  if (activeMarketTool.value === 'tracker') loadTrackerSectors()
})
watch([allSectorType, allSectorSort, allSectorOrder], () => {
  if (allSectorsOpen.value) loadAllSectors()
})
</script>

<template>
  <div class="market-page">
    <van-nav-bar title="行情" :border="false">
      <template #right>
        <button class="refresh-action" type="button" :disabled="isRefreshing" aria-label="刷新行情" @click="onRefresh">
          <van-icon name="replay" :class="{ spinning: isRefreshing }" size="20" />
        </button>
      </template>
    </van-nav-bar>

    <van-pull-refresh v-model="isRefreshing" class="market-scroll" @refresh="onRefresh">
      <main class="market-tab-container">
        <MarketIndexBoard variant="market" />
        <section class="market-index-section" aria-labelledby="indices-title">
          <div class="market-section-header">
            <h2 id="indices-title" class="market-section-title">主要指数</h2>
            <div class="market-index-actions">
              <span class="market-section-meta">最新快照</span>
              <button type="button" class="market-icon-button" title="管理指数" aria-label="管理指数" @click="indexManagerOpen = true"><van-icon name="setting-o" size="16" /></button>
            </div>
          </div>
          <div v-if="snapshotLoading && !indices.length" class="market-index-grid">
            <span v-for="item in MAX_INDEX_COUNT" :key="item" class="index-skeleton glass" />
          </div>
          <div v-else-if="visibleIndices.length" class="market-index-grid">
            <article v-for="item in visibleIndices" :key="item.code" class="market-index-card glass">
              <div class="index-name-line"><span>{{ item.name }}</span></div>
              <strong>{{ number(item.price) }}</strong>
              <span :class="['index-change', valueClass(item.changePercent)]">{{ percent(item.changePercent) }}</span>
            </article>
          </div>
        </section>

        <van-popup v-model:show="indexManagerOpen" class="index-manager-popup" :closeable="true" close-icon="cross" :safe-area-inset-bottom="true">
          <div class="index-manager-header"><h2>管理指数看板</h2><p>显示最多 6 个指数</p></div>
          <div class="index-manager-section">
            <div class="index-manager-label"><span>显示指数</span><button type="button" class="index-restore-button" @click="restoreDefaultIndices">恢复默认</button></div>
            <div v-for="(code, position) in indexOrder" :key="code" :data-index-code="code" :class="['index-manager-row', { dragging: draggedIndexCode === code }]" @dragover.prevent @drop.prevent="finishIndexDrag(code)">
              <template v-if="indices.find(index => index.code === code)">
                <div class="index-manager-name"><strong>{{ indices.find(index => index.code === code)?.name }}</strong><small>{{ code }}</small></div>
                <div class="index-manager-tools">
                  <button type="button" class="market-icon-button index-drag-handle" title="拖拽排序" aria-label="拖拽排序" draggable="true" @dragstart="startIndexDrag(code, $event)" @dragend="endIndexPointerDrag" @pointerdown="startIndexPointerDrag(code, $event)" @pointermove="moveIndexByPointer" @pointerup="endIndexPointerDrag" @pointercancel="endIndexPointerDrag"><van-icon name="apps-o" /></button>
                  <button type="button" class="market-icon-button danger" title="移除" @click="removeIndex(code)"><van-icon name="delete-o" /></button>
                </div>
              </template>
            </div>
          </div>
          <div class="index-manager-section">
            <div class="index-manager-label"><span>可选指数</span></div>
            <div class="index-options"><button v-for="item in availableIndices" :key="item.code" type="button" :disabled="indexOrder.length >= MAX_INDEX_COUNT" @click="addIndex(item.code)">{{ item.name }}</button></div>
          </div>
          <div class="index-manager-footer"><button type="button" @click="indexManagerOpen = false">完成</button></div>
        </van-popup>

        <section class="market-section" aria-labelledby="sectors-title">
          <div class="market-section-header">
            <div class="market-header-controls">
              <h2 id="sectors-title" class="market-section-title">热门板块</h2>
              <div class="toggle-group" role="tablist" aria-label="板块类型">
                <button type="button" :class="{ active: sectorFilter === 'industry' }" @click="selectSectorFilter('industry')">申万三级行业</button>
                <button type="button" :class="{ active: sectorFilter === 'concept' }" @click="selectSectorFilter('concept')">东财概念</button>
              </div>
              <div class="toggle-group sort-group" aria-label="板块排序">
                <button type="button" class="sector-sort-rise" :class="{ active: sectorSort === 'changePercent' && sectorSortOrder === 'desc' }" @click="selectSectorSort('changePercent', 'desc')">
                  涨幅 <van-icon name="arrow-up" />
                </button>
                <button type="button" class="sector-sort-fall" :class="{ active: sectorSort === 'changePercent' && sectorSortOrder === 'asc' }" @click="selectSectorSort('changePercent', 'asc')">
                  跌幅 <van-icon name="arrow-down" />
                </button>
                <button type="button" class="sector-sort-rise" :class="{ active: sectorSort === 'netInflow' && sectorSortOrder === 'desc' }" @click="selectSectorSort('netInflow', 'desc')">
                  流入 <van-icon name="arrow-up" />
                </button>
                <button type="button" class="sector-sort-fall" :class="{ active: sectorSort === 'netInflow' && sectorSortOrder === 'asc' }" @click="selectSectorSort('netInflow', 'asc')">流出 <van-icon name="arrow-down" /></button>
              </div>
              <button type="button" class="sector-live-tracker" @click="openSectorTracker"><van-icon name="chart-trending-o" /> 实时板块资金流向追踪</button>
              <button type="button" class="sector-bubble-action" aria-label="打开分时气泡图" @click="openSectorBubble"><van-icon name="cluster-o" /> 分时气泡图</button>
            </div>
            <button type="button" class="market-section-more" @click="openAllSectors">全部 <van-icon name="arrow" /></button>
          </div>

          <section v-if="activeMarketTool !== 'index'" class="market-tool-panel">
            <SectorBubbleChart
              v-if="activeMarketTool === 'bubble'"
              :sectors="bubbleSectors"
              :type="sectorFilter === 'concept' ? 'concept' : 'industry'"
              :updated-at="bubbleUpdatedAt"
              :index="bubbleIndex"
              :loading="bubbleSectorsLoading"
              :error="bubbleSectorsError"
              @close="activeMarketTool = 'index'"
              @select="selectBubbleSector"
              @type-change="selectSectorFilter"
            />
            <SectorFlowTracker
              v-else
              :sectors="trackerSectors"
              :type="sectorFilter === 'concept' ? 'concept' : 'industry'"
              :updated-at="trackerSectors[0]?.updatedAt || null"
              @close="activeMarketTool = 'index'"
              @select="selectTrackedSector"
              @type-change="selectSectorFilter"
            />
            <div v-if="activeMarketTool === 'tracker' && trackerSectorsLoading" class="tracker-loading-overlay">正在读取后端板块缓存...</div>
            <div v-else-if="activeMarketTool === 'tracker' && trackerSectorsError" class="tracker-loading-overlay error">{{ trackerSectorsError }}</div>
          </section>

          <div v-if="featuredSectorsLoading && !sectors.length" class="market-sector-grid">
            <span v-for="item in 12" :key="item" class="market-sector-skeleton glass" />
          </div>
          <div v-else-if="filteredSectors.length" class="market-sector-grid">
            <button v-for="sector in filteredSectors" :key="sector.code" type="button" class="market-sector-card glass" @click="goToSectorDetail(sector)">
              <div class="market-sector-main">
                <span class="market-sector-name">{{ sector.name }}</span>
                <strong v-if="sectorSort === 'changePercent'" :class="valueClass(sector.changePercent)">{{ percent(sector.changePercent) }}</strong>
                <strong v-else :class="valueClass(sector.netInflow)">{{ formatFlow(sector.netInflow) }}</strong>
              </div>
              <small class="market-sector-detail">
                <template v-if="sectorSort === 'changePercent'">资金流入：{{ formatFlow(sector.netInflow) }}</template>
                <template v-else>涨跌幅：<span :class="valueClass(sector.changePercent)">{{ percent(sector.changePercent) }}</span></template>
              </small>
            </button>
          </div>
          <div v-else class="market-empty glass">暂无匹配的板块数据</div>
          <button v-if="sectors.length > 12" type="button" class="market-sector-expand" @click="sectorsExpanded = !sectorsExpanded">
            {{ sectorsExpanded ? '收起板块' : '展开更多板块' }} <van-icon :name="sectorsExpanded ? 'arrow-up' : 'arrow-down'" />
          </button>
          <p v-if="sectorUpdatedAt !== '--'" class="mapping-note">{{ sectorFilter === 'industry' ? '申万三级行业（东方财富实时行情）' : '东方财富概念板块' }} 更新 {{ sectorUpdatedAt }}</p>
        </section>

        <van-popup v-model:show="allSectorsOpen" class="all-sectors-popup" :closeable="true" close-icon="cross" :safe-area-inset-bottom="true">
          <div class="all-sectors-header"><h2>全部板块</h2></div>
          <div class="all-sectors-controls">
            <div class="all-control-row"><span>板块类别</span><div class="toggle-group"><button type="button" :class="{ active: allSectorType === 'industry' }" @click="allSectorType = 'industry'">申万三级行业</button><button type="button" :class="{ active: allSectorType === 'concept' }" @click="allSectorType = 'concept'">东财概念</button></div></div>
            <div class="all-control-row"><span>排序类别</span><div class="toggle-group"><button type="button" class="sector-sort-rise" :class="{ active: allSectorSort === 'change' && allSectorOrder === 'desc' }" @click="selectAllSectorSort('change', 'desc')">涨幅 <van-icon name="arrow-up" /></button><button type="button" class="sector-sort-fall" :class="{ active: allSectorSort === 'change' && allSectorOrder === 'asc' }" @click="selectAllSectorSort('change', 'asc')">跌幅 <van-icon name="arrow-down" /></button><button type="button" class="sector-sort-rise" :class="{ active: allSectorSort === 'flow' && allSectorOrder === 'desc' }" @click="selectAllSectorSort('flow', 'desc')">流入 <van-icon name="arrow-up" /></button><button type="button" class="sector-sort-fall" :class="{ active: allSectorSort === 'flow' && allSectorOrder === 'asc' }" @click="selectAllSectorSort('flow', 'asc')">流出 <van-icon name="arrow-down" /></button></div></div>
          </div>
          <div class="all-sectors-table-wrap">
            <div class="all-sectors-table-head"><span>板块名称</span><span>涨跌幅</span><span>资金流入</span></div>
            <div v-if="allSectorsLoading" class="all-sectors-loading">正在加载后端板块表…</div>
            <div v-else-if="!allSectors.length" class="all-sectors-loading">暂无板块数据</div>
            <div v-else class="all-sectors-list"><div v-for="sector in allSectors" :key="sector.code" class="all-sectors-row"><span>{{ sector.name }}</span><strong :class="valueClass(sector.changePercent)">{{ percent(sector.changePercent) }}</strong><strong :class="valueClass(sector.netInflow)">{{ formatFlow(sector.netInflow) }}</strong></div></div>
          </div>
        </van-popup>

        <section class="market-ranking-section glass" aria-labelledby="ranking-title">
          <div class="market-ranking-tabs" role="tablist" aria-label="基金排行类型">
            <button
              v-for="item in rankTabs"
              :key="item.key"
              type="button"
              :class="{ active: activeRankTab === item.key }"
              :aria-selected="activeRankTab === item.key"
              @click="activeRankTab = item.key"
            >
              {{ item.label }}
            </button>
          </div>
          <div class="market-ranking-table">
            <div class="market-ranking-header">
              <span id="ranking-title">基金名称</span><span>当日涨幅</span><span>近一年涨幅</span>
            </div>
            <template v-if="rankingLoading && !ranking.length">
              <div v-for="item in 8" :key="item" class="market-ranking-row market-ranking-skeleton"><span /><span /><span /></div>
            </template>
            <button v-for="item in ranking" :key="item.code" class="market-ranking-row" type="button" @click="goToDetail(item.code)">
              <span class="fund-name-cell"><strong>{{ item.name }}</strong><small>#{{ item.code }} · {{ rankingDate(item) }}</small></span>
              <span :class="valueClass(item.dailyReturn)">{{ percent(item.dailyReturn) }}</span>
              <span :class="['ranking-year-value', valueClass(item.yearReturn)]">{{ percent(item.yearReturn) }}</span>
            </button>
            <div v-if="!rankingLoading && !ranking.length" class="market-empty ranking-empty">暂无基金排行数据</div>
          </div>
        </section>

        <div v-if="loadError" class="error-state"><span>{{ loadError }}</span><button type="button" @click="loadMarket">重试</button></div>
      </main>
    </van-pull-refresh>
  </div>
</template>

<style scoped>
.market-page { min-height: 100vh; padding-bottom: 60px; color: var(--text-primary); background: var(--bg-primary); }
.market-index-section { display: none !important; }
.market-page :deep(.van-nav-bar) { background: var(--bg-secondary); }.refresh-action { display: grid; width: 36px; height: 36px; place-items: center; border: 0; color: var(--text-primary); background: transparent; cursor: pointer; }.refresh-action:disabled { opacity: .45; }.spinning { animation: spin .8s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
.market-scroll { height: calc(100vh - 46px); overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain; }.market-tab-container { display: flex; flex-direction: column; gap: 16px; max-width: 1080px; margin: 0 auto; padding: 14px 12px calc(24px + env(safe-area-inset-bottom, 0px)); }
.glass { border: 1px solid var(--border-color); background: var(--bg-secondary); box-shadow: 0 8px 24px rgba(0, 0, 0, .05); }.market-section, .market-index-section { display: flex; flex-direction: column; gap: 12px; }.market-section-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 4px; }.market-header-controls { display: flex; align-items: center; min-width: 0; gap: 8px; }.market-section-title { flex: 0 0 auto; margin: 0; color: var(--text-primary); font-size: 16px; line-height: 22px; font-weight: 600; }.market-section-meta, .mapping-note { color: var(--text-secondary); font-size: 11px; }.market-section-more { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 2px; border: 0; color: var(--text-secondary); background: transparent; font-size: 12px; cursor: pointer; }.market-index-actions { display: inline-flex; align-items: center; gap: 4px; }.market-icon-button { display: inline-grid; width: 28px; height: 28px; place-items: center; padding: 0; border: 0; border-radius: 4px; color: var(--text-secondary); background: transparent; cursor: pointer; }.market-icon-button:active { background: var(--bg-tertiary); }.market-icon-button:disabled { cursor: default; opacity: .35; }.market-icon-button.danger { color: #dc2626; }
.toggle-group { display: inline-flex; overflow: hidden; padding: 2px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-secondary); box-shadow: inset 0 1px 2px rgba(0, 0, 0, .04); }.toggle-group button { display: inline-flex; align-items: center; gap: 2px; height: 24px; padding: 0 8px; border: 0; border-radius: 4px; color: var(--text-secondary); background: transparent; font-size: 10px; cursor: pointer; }.toggle-group button.active { color: var(--text-primary); background: var(--bg-primary); box-shadow: 0 1px 3px rgba(0, 0, 0, .12); }
.toggle-group button.sector-sort-rise.active { color: #fff; background: var(--color-up); }.toggle-group button.sector-sort-fall.active { color: #fff; background: var(--color-down); }.sector-live-tracker { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; color: var(--text-secondary); background: transparent; font-size: 11px; white-space: nowrap; cursor: pointer; }.sector-live-tracker:active { color: var(--color-primary); }.sector-bubble-action { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 7px; border: 1px solid color-mix(in srgb, var(--color-primary) 46%, var(--border-color)); border-radius: 4px; color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 8%, transparent); font-size: 10px; white-space: nowrap; cursor: pointer; }.sector-bubble-action:active { opacity: .72; }
.market-index-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }.market-index-card { min-width: 0; min-height: 66px; padding: 8px; border-radius: 8px; }.index-name-line { display: flex; gap: 6px; color: var(--text-secondary); font-size: 10px; }.index-name-line span { overflow: hidden; color: var(--text-primary); font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }.market-index-card strong { display: block; margin-top: 5px; overflow: hidden; font-size: 14px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }.index-change { display: block; margin-top: 2px; overflow: hidden; font-size: 10px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }.index-skeleton { min-height: 66px; border-radius: 8px; }
.market-sector-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }.market-sector-card { display: flex; min-width: 0; min-height: 78px; padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); flex-direction: column; gap: 8px; overflow: hidden; text-align: left; cursor: pointer; }.market-sector-card:active { background: var(--bg-tertiary); }.market-sector-main { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }.market-sector-name { overflow: hidden; color: var(--text-primary); font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }.market-sector-main strong { flex: 0 0 auto; font-size: 13px; font-variant-numeric: tabular-nums; }.market-sector-detail { overflow: hidden; color: var(--text-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.market-sector-skeleton { min-height: 78px; border-radius: 8px; }.market-sector-expand { display: inline-flex; align-self: center; align-items: center; gap: 3px; min-height: 30px; padding: 0 10px; border: 0; color: var(--color-primary); background: transparent; font-size: 12px; cursor: pointer; }.mapping-note { margin: -4px 4px 0; }.up { color: var(--color-up); }.down { color: var(--color-down); }.flat { color: var(--text-secondary); }
.market-ranking-section { overflow: hidden; border-radius: 12px; }.market-ranking-tabs { display: flex; gap: 14px; overflow-x: auto; padding: 12px 14px 0; border-bottom: 1px solid var(--border-color); scrollbar-width: none; }.market-ranking-tabs::-webkit-scrollbar { display: none; }.market-ranking-tabs button { position: relative; flex: 0 0 auto; padding: 0 0 11px; border: 0; color: var(--text-secondary); background: transparent; font-size: 13px; font-weight: 500; cursor: pointer; }.market-ranking-tabs button.active { color: var(--text-primary); font-weight: 600; }.market-ranking-tabs button.active::after { position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: 2px; background: var(--color-primary); content: ''; }.market-ranking-header, .market-ranking-row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(64px, 1fr) minmax(70px, 1fr); align-items: center; gap: 8px; }.market-ranking-header { padding: 9px 14px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 11px; }.market-ranking-header span:not(:first-child), .market-ranking-row > span:not(:first-child) { text-align: right; }.market-ranking-row { width: 100%; min-height: 60px; padding: 10px 14px; border: 0; border-bottom: 1px solid rgba(127, 127, 127, .12); color: var(--text-primary); background: transparent; text-align: left; cursor: pointer; transition: background .2s ease; }.market-ranking-row:active { background: var(--bg-tertiary); }.fund-name-cell { min-width: 0; }.fund-name-cell strong, .fund-name-cell small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.fund-name-cell strong { font-size: 13px; font-weight: 600; }.fund-name-cell small { margin-top: 4px; color: var(--text-secondary); font-size: 10px; }.market-ranking-row > span:not(:first-child) { font-size: 12px; font-variant-numeric: tabular-nums; }.ranking-year-value { font-weight: 700; }.market-ranking-skeleton { cursor: default; }.market-ranking-skeleton span { height: 12px; background: var(--bg-tertiary); }.market-ranking-skeleton span:first-child { width: 72%; }.market-ranking-skeleton span:not(:first-child) { justify-self: end; width: 48px; }.market-empty { display: grid; min-height: 76px; place-items: center; border-radius: 10px; color: var(--text-secondary); font-size: 12px; }.ranking-empty { border-radius: 0; }.error-state { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-left: 3px solid #dc2626; color: #dc2626; background: rgba(220, 38, 38, .08); font-size: 12px; }.error-state button { border: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }
.all-sectors-popup { display: flex; width: min(680px, calc(100vw - 24px)); height: min(86vh, 820px); max-height: 86vh; flex-direction: column; overflow: hidden; border: 1px solid var(--border-color); border-radius: 12px; color: var(--text-primary); background: var(--bg-primary); }.all-sectors-header { display: flex; align-items: center; min-height: 64px; padding: 0 52px 0 16px; border-bottom: 1px solid var(--border-color); }.all-sectors-header h2 { margin: 0; font-size: 17px; font-weight: 650; }.all-sectors-controls { display: grid; gap: 12px; padding: 16px; border-bottom: 1px solid var(--border-color); }.all-control-row { display: flex; align-items: center; gap: 12px; }.all-control-row > span { flex: 0 0 56px; color: var(--text-primary); font-size: 12px; }.all-sectors-table-wrap { display: flex; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }.all-sectors-table-head, .all-sectors-row { display: grid; grid-template-columns: minmax(0, 1fr) 92px 116px; align-items: center; gap: 8px; }.all-sectors-table-head { min-height: 38px; padding: 0 14px; color: var(--text-secondary); background: var(--bg-tertiary); font-size: 11px; }.all-sectors-table-head span:not(:first-child), .all-sectors-row strong { text-align: right; }.all-sectors-list { overflow-y: auto; }.all-sectors-row { min-height: 37px; padding: 0 14px; border-bottom: 1px solid rgba(127, 127, 127, .12); font-size: 12px; }.all-sectors-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.all-sectors-row strong { font-variant-numeric: tabular-nums; }.all-sectors-loading { display: grid; min-height: 120px; place-items: center; color: var(--text-secondary); font-size: 12px; }
.market-tool-panel { position: relative; overflow: hidden; border: 1px solid rgba(145, 174, 220, .22); border-radius: 8px; background: #101b30; box-shadow: 0 8px 24px rgba(0, 0, 0, .12); }.tracker-loading-overlay { position: absolute; z-index: 4; top: 0; right: 0; bottom: 0; left: 0; display: grid; place-items: center; color: #c3d2e9; background: rgba(10, 19, 36, .72); font-size: 13px; pointer-events: none; }.tracker-loading-overlay.error { color: #ff9a9a; }
.index-manager-popup { width: min(440px, calc(100vw - 24px)); max-height: min(80vh, 700px); overflow-y: auto; border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); background: var(--bg-primary); }.index-manager-header { padding: 20px 52px 12px 18px; border-bottom: 1px solid var(--border-color); }.index-manager-header h2 { margin: 0; font-size: 18px; line-height: 26px; }.index-manager-header p { margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; }.index-manager-section { padding: 14px 16px 4px; }.index-manager-label { display: flex; align-items: center; justify-content: space-between; min-height: 28px; margin-bottom: 6px; color: var(--text-secondary); font-size: 12px; }.index-restore-button { padding: 0; border: 0; color: var(--color-primary); background: transparent; font-size: 12px; cursor: pointer; }.index-manager-row { display: flex; min-height: 58px; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(127, 127, 127, .12); }.index-manager-name { display: flex; min-width: 0; flex-direction: column; gap: 2px; }.index-manager-name strong { overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }.index-manager-name small { color: var(--text-secondary); font-size: 11px; }.index-manager-tools { display: inline-flex; flex: 0 0 auto; gap: 1px; }.index-options { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 10px; }.index-options button { min-height: 30px; padding: 0 10px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); background: var(--bg-secondary); font-size: 12px; cursor: pointer; }.index-options button:disabled { opacity: .45; }.index-manager-footer { display: flex; justify-content: flex-end; padding: 12px 16px calc(16px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--border-color); }.index-manager-footer button { min-width: 68px; height: 34px; border: 0; border-radius: 4px; color: #fff; background: var(--color-primary); font-size: 13px; cursor: pointer; }.index-manager-row.dragging { opacity: .55; }.index-drag-handle { cursor: grab; touch-action: none; }.index-drag-handle:active { cursor: grabbing; }
@media (min-width: 641px) { .market-sector-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }.market-sector-card { min-height: 82px; padding: 10px; }.market-sector-name { font-size: 12px; }.market-sector-main strong { font-size: 11px; }.market-sector-detail { font-size: 10px; }.market-sector-card:hover { background: var(--bg-tertiary); }.market-ranking-row:hover { background: rgba(127, 127, 127, .06); } }
@media (max-width: 700px) { .market-header-controls { flex-wrap: wrap; }.sector-live-tracker { order: 4; margin-left: auto; }.sector-bubble-action { order: 5; } }
@media (max-width: 480px) { .market-tab-container { padding-right: 10px; padding-left: 10px; }.market-section-header { align-items: flex-start; margin: 0; }.market-header-controls { flex-wrap: wrap; gap: 6px; }.market-section-title { width: 100%; }.sort-group { margin-left: auto; }.market-ranking-tabs { gap: 12px; }.market-ranking-header, .market-ranking-row { grid-template-columns: minmax(0, 1fr) 66px 76px; gap: 6px; padding-right: 10px; padding-left: 10px; }.market-sector-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }.market-sector-card { min-height: 70px; padding: 8px; gap: 5px; }.market-sector-name { font-size: 11px; }.market-sector-main strong { font-size: 10px; }.market-sector-detail { font-size: 9px; } }
</style>
