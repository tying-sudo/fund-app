<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  fetchSectorDetail,
  type SectorDetail,
  type SectorDetailPeriod
} from '@/api/market'
import SectorTrendChart from '@/components/SectorTrendChart.vue'

defineOptions({ name: 'SectorDetail' })

const route = useRoute()
const router = useRouter()
const periods: Array<{ value: SectorDetailPeriod; label: string }> = [
  { value: '1d', label: '分时' },
  { value: '1m', label: '1月' },
  { value: '3m', label: '3月' },
  { value: '1y', label: '1年' }
]

const period = ref<SectorDetailPeriod>('1d')
const detail = ref<SectorDetail | null>(null)
const loading = ref(true)
const loadError = ref('')

const sectorCode = computed(() => String(route.params.code || '').trim())
const sectorName = computed(() => String(route.query.name || '').trim())
const sectorType = computed(() => route.query.type === 'concept' ? 'concept' : 'industry')
const displayName = computed(() => detail.value?.sector.name || sectorName.value || '板块详情')
const points = computed(() => detail.value?.trend.points || [])
const change = computed(() => detail.value?.sector.changePercent ?? null)
const relatedFundsHint = computed(() =>
  detail.value?.relatedFunds[0]?.relatedSource === 'constituent_holdings'
    ? '成分股持仓匹配'
    : '主题映射匹配'
)

function numeric(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? '--' : value.toFixed(digits)
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? '--' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function valueClass(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return 'flat'
  return value > 0 ? 'up' : 'down'
}

function flow(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  const unit = Math.abs(value) >= 100000000 ? 100000000 : 10000
  return `${value > 0 ? '+' : ''}${(value / unit).toFixed(2)}${unit === 100000000 ? '亿' : '万'}`
}

async function loadDetail() {
  if (!sectorCode.value) {
    loadError.value = '缺少板块代码，无法加载详情'
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    detail.value = await fetchSectorDetail(sectorCode.value, sectorName.value, sectorType.value, period.value)
  } catch (error) {
    detail.value = null
    loadError.value = error instanceof Error ? error.message : '板块详情加载失败'
  } finally {
    loading.value = false
  }
}

function selectPeriod(next: SectorDetailPeriod) {
  if (period.value !== next) period.value = next
}

function openFund(code: string) {
  router.push(`/detail/${code}`)
}

onMounted(loadDetail)
watch([sectorCode, sectorName, sectorType, period], loadDetail)
</script>

<template>
  <div class="sector-detail-page">
    <van-nav-bar :title="displayName" left-arrow :border="false" @click-left="router.back()" />

    <main class="sector-detail-content">
      <div v-if="loading && !detail" class="sector-detail-loading">
        <van-loading size="22" />
        <span>正在加载板块实时数据</span>
      </div>

      <div v-else-if="loadError" class="sector-detail-error">
        <span>{{ loadError }}</span>
        <button type="button" @click="loadDetail">重试</button>
      </div>

      <template v-else-if="detail">
        <section class="overview-section" aria-labelledby="overview-title">
          <div class="overview-heading">
            <div>
              <h2 id="overview-title">板块概览</h2>
              <p>{{ detail.sector.price === null ? '指数点位暂未返回' : `板块点位 ${numeric(detail.sector.price)}` }} <span v-if="detail.sector.date">· {{ detail.sector.date }}</span></p>
            </div>
            <strong :class="valueClass(change)">{{ percent(change) }}</strong>
          </div>
          <div class="breadth-grid">
            <div><span>上涨</span><strong class="up">{{ detail.breadth.up }}</strong></div>
            <div><span>下跌</span><strong class="down">{{ detail.breadth.down }}</strong></div>
            <div><span>平盘</span><strong class="flat">{{ detail.breadth.flat }}</strong></div>
            <div><span>成分股</span><strong>{{ detail.breadth.total || '--' }}</strong></div>
          </div>
          <p v-if="!detail.sector.mapped && !detail.relatedFunds.length" class="mapping-hint">该板块不在本地精选映射中，未展示关联基金。</p>
        </section>

        <section class="trend-section" aria-labelledby="trend-title">
          <div class="section-title-row">
            <h2 id="trend-title">板块走势</h2>
            <span :class="valueClass(change)">{{ periods.find(item => item.value === period)?.label }} {{ percent(change) }}</span>
          </div>
          <div class="period-tabs" role="tablist" aria-label="走势周期">
            <button v-for="item in periods" :key="item.value" type="button" :class="{ active: period === item.value }" :aria-selected="period === item.value" @click="selectPeriod(item.value)">{{ item.label }}</button>
          </div>
          <div v-if="loading" class="chart-state"><van-loading size="18" /> 更新走势</div>
          <SectorTrendChart v-else-if="points.length > 1" :name="displayName" :period="period" :points="points" />
          <div v-else class="chart-state">当前周期暂无可用走势数据</div>
          <div class="trend-summary">
            <span>资金流向 <strong :class="valueClass(detail.sector.netInflow)">{{ flow(detail.sector.netInflow) }}</strong></span>
            <span>昨收 <strong>{{ numeric(detail.sector.previousClose) }}</strong></span>
          </div>
        </section>

        <section class="detail-list-section" aria-labelledby="funds-title">
          <div class="section-title-row"><div><h2 id="funds-title">相关基金</h2><p>{{ relatedFundsHint }}</p></div><span>{{ detail.relatedFunds.length }} 只</span></div>
          <div v-if="detail.relatedFunds.length" class="detail-table">
            <div class="detail-table-head funds-columns"><span>基金</span><span>最新净值</span><span>日涨跌</span></div>
            <button v-for="fund in detail.relatedFunds" :key="fund.code" type="button" class="detail-row funds-columns" @click="openFund(fund.code)">
              <span class="row-name"><strong>{{ fund.name }}</strong><small>{{ fund.code }}<template v-if="fund.navDate"> · {{ fund.navDate }}</template></small></span>
              <span>{{ numeric(fund.unitNav, 4) }}</span>
              <strong :class="valueClass(fund.dailyReturn)">{{ percent(fund.dailyReturn) }}</strong>
            </button>
          </div>
          <p v-else class="empty-row">该精选板块暂无可用的基金关联记录。</p>
        </section>

        <section class="detail-list-section" aria-labelledby="stocks-title">
          <div class="section-title-row"><div><h2 id="stocks-title">成分股</h2><p>东方财富实时板块成分</p></div><span>{{ detail.breadth.total || detail.constituents.length }} 只</span></div>
          <div v-if="detail.constituents.length" class="detail-table">
            <div class="detail-table-head stocks-columns"><span>股票</span><span>现价</span><span>涨跌幅</span><span>换手</span></div>
            <div v-for="stock in detail.constituents" :key="stock.code" class="detail-row stocks-columns">
              <span class="row-name"><strong>{{ stock.name }}</strong><small>{{ stock.code }}</small></span>
              <span>{{ numeric(stock.price) }}</span>
              <strong :class="valueClass(stock.changePercent)">{{ percent(stock.changePercent) }}</strong>
              <span>{{ stock.turnover === null ? '--' : `${numeric(stock.turnover)}%` }}</span>
            </div>
          </div>
          <p v-else class="empty-row">东方财富暂未返回该板块的成分股数据。</p>
        </section>

        <p class="source-note">数据来源：东方财富板块行情；相关基金按已备份的板块与指数映射关联。</p>
      </template>
    </main>
  </div>
</template>

<style scoped>
.sector-detail-page { min-height: 100vh; padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px)); color: var(--text-primary); background: var(--bg-primary); }
.sector-detail-page :deep(.van-nav-bar) { background: var(--bg-secondary); }.sector-detail-content { width: min(760px, 100%); margin: 0 auto; }.overview-section, .trend-section, .detail-list-section { padding: 16px; border-bottom: 8px solid var(--bg-secondary); background: var(--bg-primary); }.overview-heading, .section-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }.overview-heading h2, .section-title-row h2 { margin: 0; font-size: 18px; line-height: 26px; font-weight: 650; }.overview-heading p, .section-title-row p { margin: 3px 0 0; color: var(--text-secondary); font-size: 12px; }.overview-heading > strong { flex: 0 0 auto; padding-top: 2px; font-size: 30px; line-height: 34px; font-variant-numeric: tabular-nums; }.breadth-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 14px; border-radius: 8px; background: var(--bg-secondary); }.breadth-grid div { display: flex; min-width: 0; min-height: 64px; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }.breadth-grid span, .breadth-grid strong { font-variant-numeric: tabular-nums; }.breadth-grid span { color: var(--text-secondary); font-size: 11px; }.breadth-grid strong { font-size: 16px; }.mapping-hint { margin: 10px 0 0; color: var(--text-secondary); font-size: 11px; }.section-title-row > span { padding-top: 5px; color: var(--text-secondary); font-size: 12px; }.period-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; margin-top: 14px; padding: 3px; border-radius: 6px; background: var(--bg-secondary); }.period-tabs button { height: 32px; border: 0; border-radius: 4px; color: var(--text-secondary); background: transparent; font-size: 13px; cursor: pointer; }.period-tabs button.active { color: var(--text-primary); background: var(--bg-primary); box-shadow: 0 1px 3px rgba(0, 0, 0, .08); }.chart-state { display: grid; min-height: 168px; place-items: center; gap: 8px; color: var(--text-secondary); font-size: 12px; }.trend-summary { display: flex; justify-content: space-between; margin-top: 14px; padding: 10px 12px; border-radius: 6px; color: var(--text-secondary); background: var(--bg-secondary); font-size: 12px; }.trend-summary strong { margin-left: 5px; color: var(--text-primary); font-variant-numeric: tabular-nums; }.detail-table { margin: 14px -16px -16px; }.detail-table-head, .detail-row { display: grid; align-items: center; gap: 8px; padding: 0 16px; }.funds-columns { grid-template-columns: minmax(0, 1.7fr) minmax(76px, .9fr) minmax(70px, .8fr); }.stocks-columns { grid-template-columns: minmax(0, 1.45fr) minmax(54px, .7fr) minmax(66px, .8fr) minmax(52px, .7fr); }.detail-table-head { min-height: 34px; color: var(--text-secondary); background: var(--bg-secondary); font-size: 11px; }.detail-table-head span:not(:first-child), .detail-row > span:not(:first-child), .detail-row > strong { text-align: right; }.detail-row { width: 100%; min-height: 58px; border: 0; border-bottom: 1px solid var(--border-color); color: var(--text-primary); background: transparent; text-align: left; font-size: 13px; }.detail-row[type='button'] { cursor: pointer; }.detail-row[type='button']:active { background: var(--bg-secondary); }.row-name { min-width: 0; }.row-name strong, .row-name small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.row-name strong { font-weight: 600; }.row-name small { margin-top: 3px; color: var(--text-secondary); font-size: 10px; }.detail-row > span:not(:first-child), .detail-row > strong { font-variant-numeric: tabular-nums; }.empty-row { margin: 16px 0 0; padding: 16px; border-radius: 6px; color: var(--text-secondary); background: var(--bg-secondary); font-size: 12px; text-align: center; }.source-note { margin: 0; padding: 14px 16px; color: var(--text-secondary); background: var(--bg-secondary); font-size: 11px; line-height: 18px; }.sector-detail-loading, .sector-detail-error { display: grid; min-height: 240px; place-items: center; align-content: center; gap: 12px; color: var(--text-secondary); font-size: 13px; }.sector-detail-error { color: var(--color-down); }.sector-detail-error button { min-width: 64px; height: 30px; border: 0; border-radius: 4px; color: #fff; background: var(--color-primary); cursor: pointer; }.up { color: var(--color-up) !important; }.down { color: var(--color-down) !important; }.flat { color: var(--text-secondary) !important; }
@media (min-width: 640px) { .overview-section, .trend-section, .detail-list-section { padding-right: 24px; padding-left: 24px; }.detail-table { margin-right: -24px; margin-left: -24px; }.detail-table-head, .detail-row { padding-right: 24px; padding-left: 24px; } }
</style>
