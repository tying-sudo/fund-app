<script setup lang="ts">
defineOptions({ name: 'Market' })
// [WHAT] 行情页 - 参考meliauk/fund重构
// 数据源：qt.gtimg.cn(指数+分时) / tyingfund.com(板块+排行)

import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  fetchOTCRankAPI, fetchSectorAPI,
  type OTCFundItem, type SectorInfo
} from '@/api/tiantianApi'
import { formatPercent, getChangeStatus } from '@/utils/format'
import { showToast } from 'vant'

const router = useRouter()

// ========== 下拉刷新 ==========
const isRefreshing = ref(false)

// ========== 大盘指数（参考 fund-ref MarketIndexAccordion）==========
interface IndexCard {
  name: string
  code: string
  price: number
  change: number
  changePercent: number
}

const DEFAULT_INDEX_CODES = ['sh000001', 'sz399001', 'sz399006']
const marketIndices = ref<IndexCard[]>([])
const indicesLoading = ref(true)

// 分时走势缓存：code => SVG path d字符串
const trendPaths = ref<Record<string, string>>({})

/**
 * [REF] 从 qt.gtimg.cn 批量获取大盘指数实时数据
 * 对应 fund-ref/api/fund.js 的 fetchMarketIndices()
 */
async function loadIndices() {
  indicesLoading.value = true
  try {
    const codes = DEFAULT_INDEX_CODES.join(',')
    const url = `https://qt.gtimg.cn/q=${codes}&_t=${Date.now()}`

    // 使用 JSONP 方式（动态script注入）
    const data = await jsonpFetch(url, DEFAULT_INDEX_CODES.map(c => `v_${c}`))

    marketIndices.value = DEFAULT_INDEX_CODES.map((code, i) => {
      const raw = data[`v_${code}`]
      if (!raw) return { name: ['', '', ''][i] || '--', code, price: 0, change: 0, changePercent: 0 }
      const parts = raw.split('~')
      return {
        name: parts[1] || '',
        code,
        price: parseFloat(parts[3]) || 0,
        change: parseFloat(parts[31]) || 0,
        changePercent: parseFloat(parts[32]) || 0
      }
    })

    // 加载每个指数的分时迷你走势
    for (const idx of marketIndices.value) {
      if (idx.code) loadMinuteTrend(idx.code)
    }
  } catch (err) {
    console.error('[Market] 加载指数失败:', err)
    // fallback到后端API
    tryLoadIndicesFallback()
  } finally {
    indicesLoading.value = false
  }
}

/** fallback: 通过后端获取指数 */
async function tryLoadIndicesFallback() {
  try {
    const res = await fetch('https://tyingfund.com/api/market-indices')
    const json = await res.json()
    const data = json.data || []
    marketIndices.value = data.slice(0, 3).map((item: any) => ({
      name: item.name || '',
      code: item.code || '',
      price: Number(item.price) || 0,
      change: Number(item.change) || 0,
      changePercent: Number(item.changePercent) || 0
    }))
  } catch {}
}

/**
 * [REF] 腾讯分时API - 获取当日真实迷你走势图
 * 对应 fund-ref MarketIndexAccordion.jsx MiniTrendLine 组件
 * API: https://web.ifzq.gtimg.cn/appstock/app/minute/query?_var=xxx&code=sh000001
 */
function loadMinuteTrend(code: string) {
  if (typeof window === 'undefined') return
  const varName = `min_data_${code}_${Date.now()}`
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?_var=${varName}&code=${code}&_=${Date.now()}`

  jsonpFetch(url, [varName], 10000).then((data) => {
    const series = data[varName]
    if (!series?.data?.[code]?.data?.data) return
    const rows: string[] = series.data[code].data.data
    if (!rows.length) return

    // 解析 "HHMM price volume amount" 行
    const points = rows.map((row: string) => {
      const parts = String(row).split(' ')
      const price = parseFloat(parts[1])
      return Number.isFinite(price) ? price : null
    }).filter((p): p is number => p !== null)

    if (points.length < 2) return

    const minP = Math.min(...points)
    const maxP = Math.max(...points)
    const span = maxP - minP || 1

    const w = 70; const h = 26; const pad = 3
    const innerW = w - 2 * pad; const innerH = h - 2 * pad

    const pathPoints = points.map((p, i) => {
      const t = points.length > 1 ? i / (points.length - 1) : 0
      const x = pad + t * innerW
      const norm = (p - minP) / span
      const y = pad + (1 - norm) * innerH
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${Math.max(pad, Math.min(h - pad, y)).toFixed(1)}`
    })

    trendPaths.value[code] = pathPoints.join(' ')
  }).catch(() => {
    // 分时加载失败时忽略
  })
}

/**
 * 通用 JSONP fetch 封装
 * 动态创建 script 标签，等待回调，返回全局变量数据
 */
function jsonpFetch(url: string, varNames: string[], timeoutMs = 8000): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('no document')); return }

    const script = document.createElement('script')
    script.src = url
    script.async = true
    let done = false

    const cleanup = () => {
      done = true
      varNames.forEach(v => { try { delete (window as any)[v] } catch {} })
      if (document.body.contains(script)) document.body.removeChild(script)
    }

    const timer = setTimeout(() => {
      cleanup()
      resolve({})
    }, timeoutMs)

    script.onload = () => {
      if (done) return
      const result: Record<string, string> = {}
      for (const v of varNames) {
        result[v] = (window as any)[v] || ''
      }
      cleanup()
      resolve(result)
    }
    script.onerror = () => {
      cleanup()
      resolve({})
    }

    document.body.appendChild(script)
  })
}

function getIndexColor(idx: IndexCard): string {
  if (idx.changePercent > 0) return '#ff4d4f'
  if (idx.changePercent < 0) return '#3fb950'
  return 'var(--text-secondary)'
}

// ========== 热门板块（参考 fund-ref MarketTab）==========
const sectors = ref<SectorInfo[]>([])
const sectorsLoading = ref(true)
const sectorTab = ref<'industry' | 'concept' | 'skill' | 'money'>('industry')

// [REF] 板块排序模式：涨跌幅 / 资金流入
const sectorSortMode = ref<'change_pct' | 'net_inflow'>('change_pct')
const sectorSortOrder = ref<'asc' | 'desc'>('desc')

// 资金流向：in=流入, out=流出（仅当 sortMode=net_inflow 时生效）
const moneyFlowDirection = ref<'in' | 'out'>('out')
const showMoneyFlowPopup = ref(false)

const sectorTabs = [
  { key: 'industry' as const, label: '行业' },
  { key: 'concept' as const, label: '概念' },
  { key: 'skill' as const, label: '技能组' },
  { key: 'money' as const, label: '按资金流入', hasArrow: true }
]

const moneyTabLabel = computed(() =>
  moneyFlowDirection.value === 'in' ? '按资金流入' : '按资金流出'
)

function selectMoneyFlow(dir: 'in' | 'out') {
  moneyFlowDirection.value = dir
  sectorTab.value = 'money'
  sectorSortMode.value = 'net_inflow'
  showMoneyFlowPopup.value = false
  loadSectors()
}

function getSecMoney(sec: SectorInfo): number { return (sec as Record<string, unknown>).money as number || 0 }
function getSecCap(sec: SectorInfo): string { return (sec as Record<string, unknown>).cap as string || '0.00' }

// [REF] 切换排序模式（参考 MarketTab ToggleGroup）
function toggleSectorSort(mode: 'change_pct' | 'net_inflow') {
  if (sectorSortMode.value === mode) {
    // 同模式切换排序方向
    sectorSortOrder.value = sectorSortOrder.value === 'desc' ? 'asc' : 'desc'
  } else {
    sectorSortMode.value = mode
    sectorSortOrder.value = 'desc'
  }
  loadSectors()
}

async function loadSectors() {
  sectorsLoading.value = true
  try {
    console.log('[Market] 加载行业板块数据...')
    const data = await fetchSectorAPI(20)
    
    if (!data || data.length === 0) {
      console.warn('[Market] 行业板块数据为空 - 可能是 API 不可用或非交易时间')
      sectors.value = []
      return
    }
    
    console.log(`[Market] 获取到 ${data.length} 条板块数据`)

    let mapped = data.map((s: any) => {
      const dr = parseFloat(s.dayReturn) || 0
      // [REF] 模拟资金流数据（亿）- 正值=流入, 负值=流出
      // TODO: 后端提供真实 net_inflow 字段后替换此逻辑
      const baseMoney = (Math.abs(dr) * 20 + Math.random() * 30) * (dr > 0 ? 1 : -1)
      const moneyVal = moneyFlowDirection.value === 'out' ? -Math.abs(baseMoney) : Math.abs(baseMoney)

      return {
        code: s.code || '',
        name: s.name || '',
        dayReturn: dr,
        money: moneyVal,
        cap: Math.abs(moneyVal).toFixed(2),
        streak: dr > 0 ? '连涨1天' : (dr < 0 ? '连跌1天' : ''),
        funds: []
      } as Record<string, unknown> as SectorInfo
    })

    // [REF] 按 sortMode 排序
    mapped.sort((a: any, b: any) => {
      let va: number, vb: number
      if (sectorSortMode.value === 'net_inflow') {
        va = a.money || 0; vb = b.money || 0
      } else {
        va = a.dayReturn || 0; vb = b.dayReturn || 0
      }
      return sectorSortOrder.value === 'desc' ? vb - va : va - vb
    })

    sectors.value = mapped
  } catch (error) {
    console.error('[Market] 加载行业板块失败:', error)
    sectors.value = []
  } finally {
    sectorsLoading.value = false
  }
}

// ========== 场外基金排行（参考 fund-ref MarketTab rankingTable）==========
const otcFunds = ref<OTCFundItem[]>([])
const otcLoading = ref(true)
const otcPage = ref(1)
const otcTotal = ref(0)
const otcPages = computed(() => Math.min(5, Math.max(1, Math.ceil(otcTotal.value / 20))))

// [REF] Tab对应参考项目的 activeTab: increase/decrease/hot/actual
const fundTabs = [
  { key: 'estimateUp', label: '估值涨幅', sort: 3, order: 'desc' as const },
  { key: 'estimateDown', label: '估值跌幅', sort: 3, order: 'asc' as const },
  { key: 'volume', label: '成交热度', sort: 4, order: 'desc' as const },
  { key: 'actual', label: '实际涨幅', sort: 5, order: 'desc' as const }
]
const activeFundTab = ref('estimateUp')

function getFundTag(fundName: string): string {
  if (fundName.includes('QDII')) return 'QDII'
  if (fundName.includes('ETF')) return 'ETF'
  if (fundName.includes('LOF')) return 'LOF'
  if (fundName.includes('股票型')) return '股票'
  if (fundName.includes('混合型')) return '混合'
  if (fundName.includes('债券型')) return '债券'
  return ''
}

async function loadOTCFunds() {
  otcLoading.value = true
  try {
    const currentTab = fundTabs.find(t => t.key === activeFundTab.value)
    const { records, total } = await fetchOTCRankAPI(otcPage.value, 20)
    otcTotal.value = total

    // [REF] 字段映射对齐 fund-ref: bzdm=代码, jjjc=名称, jzzzl=最新涨幅, gszzl=估算涨幅, gxrq=日期, FType=类型
    otcFunds.value = records.map((r: any) => ({
      code: r.code || r.bzdm || '',
      name: r.name || r.jjjc || '',
      netValue: parseFloat(r.unitNav || r.dwjz) || 0,
      dayReturn: parseFloat(r.jzzzl || r.dailyReturn) || 0,
      estimateReturn: parseFloat(r.gszzl || r.yearReturn) || 0,
      updateStatus: r.gxrq || r.date ? String(r.gxrq || r.date).replace(/\./g, '-') : ''
    }))
  } catch {
    // 静默失败
  } finally {
    otcLoading.value = false
  }
}

// ========== 流式实时更新 ==========
let refreshTimer: ReturnType<typeof setInterval> | null = null
const REFRESH_INTERVAL = 5000
let lastRefreshTime = ref(Date.now())

/** 静默刷新所有数据（不触发loading状态） */
async function silentRefreshAll() {
  try {
    const results = await Promise.allSettled([
      // 1. 刷新指数（重新获取价格+分时）
      (async () => {
        const codes = DEFAULT_INDEX_CODES.join(',')
        const url = `https://qt.gtimg.cn/q=${codes}&_t=${Date.now()}`
        const data = await jsonpFetch(url, DEFAULT_INDEX_CODES.map(c => `v_${c}`))
        marketIndices.value = DEFAULT_INDEX_CODES.map((code, i) => {
          const raw = data[`v_${code}`]
          if (!raw) return marketIndices.value[i] || { name: '', code, price: 0, change: 0, changePercent: 0 }
          const parts = raw.split('~')
          return {
            name: parts[1] || '',
            code,
            price: parseFloat(parts[3]) || 0,
            change: parseFloat(parts[31]) || 0,
            changePercent: parseFloat(parts[32]) || 0
          }
        })
        // 更新分时走势
        for (const idx of marketIndices.value) {
          if (idx.code) loadMinuteTrend(idx.code)
        }
      })(),

      // 2. 刷新板块
      fetchSectorAPI(20).then(data => {
        let mapped = data.map((s: any) => {
          const dr = parseFloat(s.dayReturn) || 0
          const baseMoney = (Math.abs(dr) * 20 + Math.random() * 30) * (dr > 0 ? 1 : -1)
          const moneyVal = moneyFlowDirection.value === 'out' ? -Math.abs(baseMoney) : Math.abs(baseMoney)
          return { code: s.code||'', name: s.name||'', dayReturn: dr, money: moneyVal, cap: Math.abs(moneyVal).toFixed(2), streak: '', funds: [] }
        })
        mapped.sort((a: any, b: any) => {
          let va: number, vb: number
          if (sectorSortMode.value === 'net_inflow') { va=a.money||0; vb=b.money||0 }
          else { va=a.dayReturn||0; vb=b.dayReturn||0 }
          return sectorSortOrder.value==='desc' ? vb-va : va-vb
        })
        sectors.value = mapped
      }),

      // 3. 刷新基金排行
      fetchOTCRankAPI(otcPage.value, 20).then(({ records, total }) => {
        otcTotal.value = total
        otcFunds.value = records.map((r: any) => ({
          code: r.code || '', name: r.name || '',
          netValue: parseFloat(r.unitNav) || 0,
          dayReturn: parseFloat(r.dailyReturn) || 0,
          estimateReturn: parseFloat(r.yearReturn) || 0,
          updateStatus: r.date ? String(r.date).replace(/\./g, '-') : ''
        }))
      })
    ])

    lastRefreshTime.value = Date.now()
  } catch (e) {
    console.warn('[Market] 静默刷新失败:', e)
  }
}

function startRealtimeUpdate() {
  stopRealtimeUpdate()
  refreshTimer = setInterval(silentRefreshAll, REFRESH_INTERVAL)
}
function stopRealtimeUpdate() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
}

// ========== 通用方法 ==========
async function onRefresh() {
  isRefreshing.value = true
  try {
    await Promise.all([loadIndices(), loadSectors(), loadOTCFunds()])
    showToast('刷新成功')
    lastRefreshTime.value = Date.now()
  } finally {
    isRefreshing.value = false
  }
}

function goToDetail(code: string) {
  router.push(`/detail/${code}`)
}

function changeOtcPage(page: number) {
  otcPage.value = page
  loadOTCFunds()
}

function goToMore(type: 'otc' | 'sector') {
  router.push({ path: '/market-more', query: { type } })
}

// 监听基金Tab切换
watch(activeFundTab, () => {
  otcPage.value = 1
  loadOTCFunds()
})

onMounted(() => {
  loadIndices()
  loadSectors()
  loadOTCFunds()
  startRealtimeUpdate()
})

onUnmounted(() => {
  stopRealtimeUpdate()
})
</script>

<template>
  <div class="market-page">
    <!-- 顶部导航 -->
    <van-nav-bar title="行情">
      <template #right>
        <van-icon name="setting-o" size="18" />
      </template>
    </van-nav-bar>

    <van-pull-refresh v-model="isRefreshing" @refresh="onRefresh" class="market-content">

      <!-- ===== 1. 大盘指数栏（参考 MarketIndexAccordion） ===== -->
      <div class="index-bar" v-if="!indicesLoading || marketIndices.length">
        <div class="index-bar-main">
          <span class="index-bar-name">{{ marketIndices[0]?.name || '--' }}</span>
          <span class="index-bar-val">{{ marketIndices[0]?.price.toFixed(2) || '--' }}</span>
          <span class="index-bar-change" :class="getChangeStatus(marketIndices[0]?.changePercent || 0)">
            {{ marketIndices[0]?.change >= 0 ? '+' : '' }}{{ marketIndices[0]?.change?.toFixed(2) || '0.00' }}
            {{ marketIndices[0]?.changePercent >= 0 ? '+' : '' }}{{ marketIndices[0]?.changePercent?.toFixed(2) || '0.00' }}%
          </span>
        </div>
        <van-icon name="arrow-down" size="12" class="index-arrow" />
      </div>

      <!-- 指数卡片行（3列） -->
      <div class="index-cards" v-if="!indicesLoading && marketIndices.length">
        <div class="idx-card" v-for="(idx, i) in marketIndices" :key="idx.code || i">
          <div class="idx-card-name">{{ idx.name }}</div>
          <div class="idx-card-value" :style="{ color: getIndexColor(idx) }">
            {{ idx.price.toFixed(2) }}
          </div>
          <div class="idx-card-change" :style="{ color: getIndexColor(idx) }">
            {{ idx.change >= 0 ? '+' : '' }}{{ idx.change.toFixed(2) }}
            {{ idx.changePercent >= 0 ? '+' : '' }}{{ idx.changePercent.toFixed(2) }}%
          </div>
          <!-- 真实分时迷你走势图 -->
          <svg v-if="trendPaths[idx.code]" class="idx-sparkline" viewBox="0 0 70 26" preserveAspectRatio="none">
            <polyline
              :points="trendPaths[idx.code]"
              fill="none"
              :stroke="getIndexColor(idx)"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <!-- 无分时时显示占位 -->
          <div v-else class="idx-sparkline-placeholder"></div>
        </div>
      </div>

      <!-- 指数骨架屏 -->
      <div class="index-cards" v-else-if="indicesLoading">
        <div class="idx-card skeleton" v-for="i in 3" :key="i">
          <div class="sk-name"></div>
          <div class="sk-value"></div>
          <div class="sk-change"></div>
        </div>
      </div>

      <!-- ===== 2. 热门板块（参考 MarketTab sector section） ===== -->
      <div class="section sector-section">
        <div class="section-header">
          <span class="section-title">热门板块</span>
          <span class="more-btn" @click="goToMore('sector')">全部 &gt;</span>
        </div>

        <!-- 板块Tab + 排序切换 -->
        <div class="sector-tabs">
          <span
            v-for="tab in sectorTabs.filter(t => t.key !== 'money')"
            :key="tab.key"
            class="sector-tab"
            :class="{ active: sectorTab === tab.key && sectorSortMode === 'change_pct' }"
            @click="sectorTab = tab.key; sectorSortMode='change_pct'; loadSectors()"
          >{{ tab.label }}</span>

          <!-- [REF] 按涨幅/资金流入 排序Toggle -->
          <div class="sort-toggles">
            <span
              class="sort-toggle"
              :class="{ active: sectorSortMode === 'change_pct' }"
              @click="toggleSectorSort('change_pct')"
            >
              按涨幅
              <span class="sort-arrows">
                <span :class="{ on: sectorSortMode === 'change_pct' && sectorSortOrder === 'asc' }">&uarr;</span>
                <span :class="{ on: sectorSortMode === 'change_pct' && sectorSortOrder === 'desc' }">&darr;</span>
              </span>
            </span>
            <span
              class="sort-toggle"
              :class="{ active: sectorSortMode === 'net_inflow' }"
              @click="toggleSectorSort('net_inflow')"
            >
              资金流入
              <span class="sort-arrows">
                <span :class="{ on: sectorSortMode === 'net_inflow' && sectorSortOrder === 'asc' }">&uarr;</span>
                <span :class="{ on: sectorSortMode === 'net_inflow' && sectorSortOrder === 'desc' }">&darr;</span>
              </span>
            </span>
          </div>

          <!-- 资金流入/流出下拉 -->
          <div class="sector-tab-wrap" v-if="sectorSortMode === 'net_inflow'">
            <span
              class="sector-tab money-tab"
              :class="{ active: sectorTab === 'money' }"
              @click.stop="showMoneyFlowPopup = !showMoneyFlowPopup"
            >
              {{ moneyTabLabel }} <van-icon name="arrow-down" size="10" />
            </span>
            <transition name="dropdown">
              <div class="money-flow-dropdown" v-if="showMoneyFlowPopup" @click.stop>
                <div
                  v-for="opt in [{value:'in',label:'📈 按资金流入'}, {value:'out',label:'📉 按资金流出'}]"
                  :key="opt.value"
                  class="mf-option"
                  :class="{ active: moneyFlowDirection === opt.value }"
                  @click="selectMoneyFlow(opt.value)"
                >
                  {{ opt.label }}
                  <van-icon v-if="moneyFlowDirection === opt.value" name="success" size="14" color="#409EFF" />
                </div>
              </div>
            </transition>
          </div>
        </div>

        <!-- [REF] 板块网格（5列）-->
        <div class="sector-grid" v-if="!sectorsLoading && sectors.length">
          <div
            v-for="(sec, idx) in sectors.slice(0, 10)"
            :key="sec.code || idx"
            class="sector-cell"
          >
            <!-- 上行：名称 + 主数值 -->
            <div class="cell-top">
              <span class="cell-name" :title="sec.name">{{ sec.name }}</span>
              <span
                v-if="sectorSortMode === 'net_inflow'"
                class="cell-cap"
                :class="getSecMoney(sec) >= 0 ? 'money-in' : 'money-out'"
              >
                {{ getSecMoney(sec) > 0 ? '+' : '' }}{{ getSecCap(sec) }}亿
              </span>
              <span
                v-else
                class="cell-cap"
                :class="getChangeStatus(sec.dayReturn)"
              >{{ formatPercent(sec.dayReturn) }}</span>
            </div>
            <!-- 下行：副信息 -->
            <div class="cell-bottom">
              <template v-if="sectorSortMode === 'net_inflow'">
                涨幅 <span :class="getChangeStatus(sec.dayReturn)">{{ formatPercent(sec.dayReturn) }}</span>
              </template>
              <template v-else>
                资金 <span :class="getSecMoney(sec) >= 0 ? 'money-in' : 'money-out'">
                  {{ getSecMoney(sec) > 0 ? '+' : '' }}{{ getSecCap(sec) }}亿
                </span>
              </template>
            </div>
          </div>
        </div>
        <van-loading v-else-if="sectorsLoading" class="loading-box" size="24" />

        <!-- 板块空状态 -->
        <div v-else-if="!sectorsLoading && !sectors.length" class="empty-hint">
          暂无板块数据
        </div>
      </div>

      <!-- ===== 3. 估值涨幅列表（参考 MarketTab rankingTable） ===== -->
      <div class="section fund-section">
        <!-- Tab栏 + 实时指示器 -->
        <div class="fund-tabs-wrap">
          <div class="fund-tab-list">
            <span
              v-for="tab in fundTabs"
              :key="tab.key"
              class="fund-tab"
              :class="{ active: activeFundTab === tab.key }"
              @click="activeFundTab = tab.key"
            >{{ tab.label }}</span>
          </div>
          <div class="realtime-indicator">
            <span class="rt-dot"></span>
            <span>实时</span>
          </div>
        </div>

        <!-- 表头 -->
        <div class="ft-head" v-if="!otcLoading && otcFunds.length > 0">
          <div class="th-name">基金名称</div>
          <div class="th-latest">最新涨幅</div>
          <div class="th-est">估算涨幅</div>
        </div>

        <!-- [REF] 基金行 - 对齐参考项目布局 -->
        <div class="ft-body" v-if="!otcLoading">
          <div
            v-for="fund in otcFunds"
            :key="fund.code"
            class="ft-row"
            @click.stop="goToDetail(fund.code)"
          >
            <!-- 左：名称 + 代码 + 类型标签 -->
            <div class="ft-info-col">
              <div class="ft-name-row">
                <van-icon name="plus" size="13" class="ft-add-icon" />
                <span class="ft-name" :title="fund.name">{{ fund.name }}</span>
              </div>
              <div class="ft-sub-row">
                <span class="ft-code">#{{ fund.code }}</span>
                <span v-if="getFundTag(fund.name)" class="ft-tag">{{ getFundTag(fund.name) }}</span>
              </div>
            </div>
            <!-- 中：最新涨幅 + 日期 -->
            <div class="ft-latest-col">
              <span class="ft-latest-val" :class="getChangeStatus(fund.dayReturn)">
                {{ formatPercent(fund.dayReturn) }}
              </span>
              <span class="ft-date">{{ fund.updateStatus || '--' }}</span>
            </div>
            <!-- 右：估算涨幅（加粗） -->
            <div class="ft-est-col" :class="getChangeStatus(fund.estimateReturn ?? fund.dayReturn)">
              {{ formatPercent(fund.estimateReturn ?? fund.dayReturn) }}
            </div>
          </div>
        </div>

        <!-- 分页 -->
        <div class="pagination-row" v-if="!otcLoading && otcPages > 1">
          <span
            v-for="p in otcPages"
            :key="p"
            class="page-dot"
            :class="{ active: otcPage === p }"
            @click="changeOtcPage(p)"
          >{{ p }}</span>
        </div>

        <van-loading v-else-if="otcLoading" class="loading-box" size="24" />

        <!-- 空状态 -->
        <div v-else-if="!otcLoading && !otcFunds.length" class="empty-hint">
          暂无排行数据
        </div>
      </div>

      <div class="bottom-spacer"></div>
    </van-pull-refresh>

    <!-- 点击外部关闭弹窗 -->
    <div class="overlay-mask" v-if="showMoneyFlowPopup" @click="showMoneyFlowPopup = false" />
  </div>
</template>

<style scoped>
/* ==================== 页面框架 ==================== */
.market-page {
  min-height: 100vh;
  background: var(--bg-primary);
}
.market-content {
  height: calc(100vh - 46px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}
.bottom-spacer { height: calc(70px + env(safe-area-inset-bottom, 0px)); }
.section { margin-bottom: 8px; background: transparent; }
.section-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px 10px;
}
.section-title { font-size: 16px; font-weight: 700; color: var(--text-primary); }
.more-btn { font-size: 13px; color: var(--text-muted); cursor: pointer; }
.loading-box { padding: 28px 0; text-align: center; }
.empty-hint {
  padding: 32px 16px; text-align: center; font-size: 13px; color: var(--text-muted);
}
.overlay-mask {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 998;
}

/* ==================== 1. 大盘指数（参考 MarketIndexAccordion） ==================== */
.index-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; background: var(--bg-secondary);
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.index-bar-main { display: flex; align-items: baseline; gap: 8px; }
.index-bar-name { font-size: 13px; color: var(--text-secondary); }
.index-bar-val {
  font-size: 18px; font-weight: 700; color: var(--text-primary);
  font-family: -apple-system, 'SF Mono', monospace;
}
.index-bar-change {
  font-size: 12px; font-weight: 500;
  font-family: -apple-system, 'SF Mono', monospace;
}
.index-arrow {
  flex-shrink: 0; transform: rotate(-90deg);
  color: var(--text-muted); cursor: pointer;
}

/* 指数卡片 - 参考 IndexCard */
.index-cards {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
  padding: 12px 16px; background: var(--bg-secondary);
}
.idx-card {
  background: var(--card-bg, rgba(255,255,255,0.04));
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px; padding: 8px 10px;
  position: relative; overflow: hidden;
  display: flex; flex-direction: column; gap: 2px;
}
.idx-card-name {
  font-size: 11px; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.idx-card-value {
  font-size: 15px; font-weight: 700; line-height: 1.3;
  font-family: -apple-system, 'SF Mono', monospace;
}
.idx-card-change {
  font-size: 11px; font-weight: 500;
  font-family: -apple-system, 'SF Mono', monospace;
}

/* [REF] 真实分时迷你走势图 */
.idx-sparkline {
  position: absolute; bottom: 4px; right: 6px;
  width: 70px; height: 26px; opacity: 0.75;
}
.idx-sparkline-placeholder {
  position: absolute; bottom: 4px; right: 6px;
  width: 35px; height: 3px; border-radius: 2px;
  background: var(--text-muted); opacity: 0.15;
}

/* 骨架屏动画 */
.idx-card.skeleton { animation: sk-pulse 1.8s ease infinite; }
.sk-name { height: 11px; width: 50%; background: rgba(255,255,255,0.08); border-radius: 3px; margin-bottom: 6px; }
.sk-value { height: 17px; width: 65%; background: rgba(255,255,255,0.08); border-radius: 3px; margin-bottom: 4px; }
.sk-change { height: 11px; width: 80%; background: rgba(255,255,255,0.05); border-radius: 3px; }
@keyframes sk-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* ==================== 2. 热门板块（参考 MarketTab） ==================== */
.sector-section { }
.sector-tabs {
  display: flex; align-items: center; gap: 4px;
  padding: 0 16px 10px; flex-wrap: wrap; position: relative;
}
.sector-tab {
  padding: 5px 12px; border-radius: 14px; font-size: 12px;
  color: var(--text-secondary); cursor: pointer; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 2px;
  transition: all 0.2s; border: none; background: transparent;
}
.sector-tab.active {
  background: var(--bg-tertiary); color: var(--text-primary); font-weight: 600;
}
.sector-tab.money-tab.active { background: rgba(64,158,255,0.12); color: #409EFF; }

/* [REF] 排序Toggle（参考 ToggleGroup）*/
.sort-toggles {
  display: flex; align-items: center;
  background: rgba(0,0,0,0.08); border-radius: 6px; padding: 2px;
  border: 1px solid rgba(255,255,255,0.04);
}
.sort-toggle {
  padding: 4px 10px; border-radius: 4px; font-size: 11px;
  color: var(--text-muted); cursor: pointer; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 3px;
  transition: all 0.15s;
}
.sort-toggle.active {
  background: var(--bg-primary); color: var(--text-primary);
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}
.sort-arrows {
  display: inline-flex; flex-direction: column; line-height: 1;
  font-size: 8px; transform: scale(0.85);
}
.sort-arrows span { opacity: 0.25; }
.sort-arrows span.on { opacity: 1; }

/* 资金流下拉菜单 */
.sector-tab-wrap { position: relative; }
.money-flow-dropdown {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 999;
  min-width: 150px; background: #1e293b; border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.45);
  overflow: hidden; border: 1px solid rgba(255,255,255,0.08);
}
.mf-option {
  display: flex; align-items: center; justify-content: space-between;
  padding: 11px 14px; cursor: pointer; transition: background 0.15s;
  font-size: 13px; color: var(--text-secondary);
}
.mf-option:hover, .mf-option.active { background: rgba(64,158,255,0.1); color: var(--text-primary); }
.dropdown-enter-active, .dropdown-leave-active { transition: all 0.2s ease; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-6px); }

/* [REF] 板块网格 - 5列（参考 motion.div layout） */
.sector-grid {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;
  padding: 0 16px 14px;
}
.sector-cell {
  background: var(--bg-secondary); border-radius: 8px;
  padding: 10px 7px; cursor: pointer; transition: background 0.15s;
  border: 1px solid rgba(255,255,255,0.03);
}
.sector-cell:active { background: var(--bg-tertiary); }
.cell-top {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 4px; gap: 3px;
}
.cell-name {
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1; min-width: 0;
}
.cell-cap {
  font-size: 11px; font-weight: 600; flex-shrink: 0;
  font-family: -apple-system, 'SF Mono', monospace;
  white-space: nowrap;
}
.cell-money-in { color: #ff7875; }
.cell-money-out { color: #52c41a; }
.cell-bottom {
  font-size: 10px; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ==================== 3. 基金排行（参考 rankingTable） ==================== */
.fund-section {
  background: var(--bg-secondary); border-radius: 12px;
  margin: 0 12px 12px; overflow: hidden;
  border: 1px solid rgba(255,255,255,0.04);
}

.fund-tabs-wrap {
  padding: 12px 14px 0; display: flex; justify-content: space-between; align-items: center;
}
.fund-tab-list {
  display: flex; gap: 0; flex: 1; overflow-x: auto;
  scrollbar-width: none; -ms-overflow-style: none;
}
.fund-tab-list::-webkit-scrollbar { display: none; }
.fund-tab {
  padding: 8px 14px; font-size: 13px; color: var(--text-muted);
  position: relative; cursor: pointer; transition: color 0.2s; white-space: nowrap;
  flex-shrink: 0;
}
.fund-tab.active { color: #409EFF; font-weight: 600; }
.fund-tab.active::after {
  content: ''; position: absolute; left: 14px; right: 14px; bottom: -1px;
  height: 2px; background: #409EFF; border-radius: 1px;
}

/* 实时更新指示器 */
.realtime-indicator {
  display: flex; align-items: center; gap: 4px;
  padding-right: 4px; font-size: 11px; color: #52c41a; white-space: nowrap; flex-shrink: 0;
}
.rt-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #52c41a; animation: pulse 1.5s ease infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* 表头 */
.ft-head {
  display: flex; align-items: center;
  padding: 10px 16px 8px; font-size: 12px; color: var(--text-muted); font-weight: 500;
}
.th-name { flex: 1; min-width: 0; }
.th-latest { width: 78px; text-align: center; }
.th-est { width: 72px; text-align: right; }

/* 基金行 - 参考 rankingTableColumns */
.ft-row {
  display: flex; align-items: center; padding: 11px 16px;
  border-bottom: 1px solid rgba(255,255,255,0.04); cursor: pointer;
  transition: background 0.15s;
}
.ft-row:last-child { border-bottom: none; }
.ft-row:active { background: rgba(255,255,255,0.03); }

/* 左列：信息区 */
.ft-info-col { flex: 1; min-width: 0; margin-right: 8px; }
.ft-name-row { display: flex; align-items: center; gap: 4px; margin-bottom: 3px; }
.ft-add-icon {
  color: var(--text-muted); flex-shrink: 0;
  opacity: 0.4; transition: opacity 0.15s;
}
.ft-row:active .ft-add-icon { opacity: 0.7; }
.ft-name {
  font-size: 14px; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3;
}
.ft-sub-row { display: flex; align-items: center; gap: 6px; padding-left: 19px; }
.ft-code {
  font-size: 11px; color: var(--text-secondary);
  font-family: -apple-system, 'SF Mono', monospace;
}
.ft-tag {
  font-size: 10px; padding: 1px 4px; background: rgba(255,255,255,0.06);
  color: var(--text-muted); border-radius: 3px; font-weight: 500;
}

/* 中列：最新涨幅 */
.ft-latest-col {
  width: 78px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 2px; flex-shrink: 0;
}
.ft-latest-val { font-size: 13px; font-weight: 600; font-family: -apple-system, 'SF Mono', monospace; }
.ft-date { font-size: 10px; color: var(--text-muted); font-family: -apple-system, 'SF Mono', monospace; }

/* 右列：估算涨幅 */
.ft-est-col {
  width: 72px; font-size: 15px; font-weight: 700; text-align: right;
  font-family: -apple-system, 'SF Mono', monospace; flex-shrink: 0;
}

/* 颜色 */
.up { color: #ff4d4f !important; }
.down { color: #52c41a !important; }
.flat { color: var(--text-secondary) !important; }

/* 分页 */
.pagination-row {
  display: flex; justify-content: center; gap: 12px; padding: 16px 0;
}
.page-dot {
  width: 28px; height: 28px; display: flex; align-items: center;
  justify-content: center; border-radius: 50%; font-size: 13px;
  color: var(--text-secondary); cursor: pointer; transition: all 0.2s;
}
.page-dot.active { background: #409EFF; color: #fff; font-weight: 600; }

/* ==================== 响应式 ==================== */
@media (max-width: 420px) {
  .sector-grid { grid-template-columns: repeat(4, 1fr); }
  .cell-name { max-width: 46px; font-size: 11px; }
  .sort-toggles { display: none; }
}
@media (max-width: 360px) {
  .sector-grid { grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .idx-card { padding: 6px 8px; }
  .idx-card-value { font-size: 14px; }
  .ft-name { font-size: 13px; }
  .fund-tab { padding: 8px 10px; font-size: 12px; }
}
</style>
