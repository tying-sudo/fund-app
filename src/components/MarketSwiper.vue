<script setup lang="ts">
// [WHY] 行情页顶部市场概览滑动模块
// [WHAT] 三个页面：涨跌分布、基金涨跌分布、板块资金流向
// [HOW] 参照用户提供的涨跌分布图片样式重构

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { 
  fetchMarketOverview, fetchSectorFunds, isTradingTime,
  type MarketOverview, type SectorInfo
} from '@/api/tiantianApi'
import { fetchMarketIndicesFast, type MarketIndexSimple } from '@/api/fundFast'
import { formatPercent, getChangeStatus } from '@/utils/format'

const router = useRouter()
const activeIndex = ref(0)
const autoplayTimer = ref<number | null>(null)
const refreshTimer = ref<number | null>(null)

// [WHAT] 启动3秒轮询（页面切换）
function startAutoplay() {
  stopAutoplay()
  autoplayTimer.value = window.setInterval(() => {
    activeIndex.value = (activeIndex.value + 1) % 3
  }, 3000)
}

// [WHAT] 停止轮询
function stopAutoplay() {
  if (autoplayTimer.value) {
    clearInterval(autoplayTimer.value)
    autoplayTimer.value = null
  }
}

// [WHAT] 启动实时数据刷新（盘中每30秒刷新一次）
function startRefresh() {
  stopRefresh()
  refreshTimer.value = window.setInterval(async () => {
    if (isTradingTime()) {
      console.log('[MarketSwiper] 盘中实时刷新')
      await loadData()
    }
  }, 30000) // 30秒刷新一次
}

// [WHAT] 停止刷新
function stopRefresh() {
  if (refreshTimer.value) {
    clearInterval(refreshTimer.value)
    refreshTimer.value = null
  }
}

// ========== 涨跌分布 ==========
const indices = ref<MarketIndexSimple[]>([])
const marketOverview = ref<MarketOverview | null>(null)

// ========== 基金涨跌分布 ==========
const fundOverview = ref<MarketOverview | null>(null)

// ========== 板块资金流向 ==========
const sectors = ref<SectorInfo[]>([])

// [WHAT] 计算柱状图最大值（用于比例）
const maxDistCount = computed(() => {
  if (!marketOverview.value) return 1
  return Math.max(...marketOverview.value.distribution.map(d => d.count), 1)
})

const maxFundDistCount = computed(() => {
  if (!fundOverview.value) return 1
  return Math.max(...fundOverview.value.distribution.map(d => d.count), 1)
})

// [WHAT] 计算板块资金流向统计
const sectorFlowStats = computed(() => {
  const inflow = sectors.value
    .filter(s => s.dayReturn > 0)
    .sort((a, b) => b.dayReturn - a.dayReturn)
    .slice(0, 4)
  const outflow = sectors.value
    .filter(s => s.dayReturn < 0)
    .sort((a, b) => a.dayReturn - b.dayReturn)
    .slice(0, 4)
  return { inflow, outflow }
})

onMounted(() => {
  loadData()
  startAutoplay()
  startRefresh()
})

onUnmounted(() => {
  stopAutoplay()
  stopRefresh()
})

async function loadData() {
  try {
    // [WHAT] 盘中强制获取实时数据，不使用缓存
    const [indicesData, overviewData, sectorsData] = await Promise.all([
      fetchMarketIndicesFast(),
      fetchMarketOverview(),
      fetchSectorFunds()
    ])
    indices.value = indicesData
    fundOverview.value = overviewData
    marketOverview.value = overviewData
    sectors.value = sectorsData
    
    // [WHAT] 记录数据更新时间，便于调试
    if (overviewData) {
      console.log('[MarketSwiper] 数据已更新:', overviewData.updateTime)
    }
  } catch (error) {
    console.error('[MarketSwiper] 数据加载失败:', error)
  }
}

// [WHAT] 获取柱状颜色（参照图片：跌为绿色，涨为红色）
function getBarColor(range: string): string {
  if (range.includes('-') || range === '跌停') return 'down'
  if (range === '0~1' || range === '平盘') return 'neutral'
  return 'up'
}

// [WHAT] 点击涨跌分布柱子
function onDistributionClick(item: { range: string; count: number }) {
  if (item.count > 0) {
    // 可以跳转到对应筛选页面
  }
}

// [WHAT] 跳转到大盘详情
function goToMarket() {
  router.push('/market')
}
</script>

<template>
  <div class="market-swiper-container">
            <van-swipe 
      v-model="activeIndex" 
      :autoplay="0" 
      :loop="true"
      :show-indicators="false"
      class="market-swipe"
      @touchstart="stopAutoplay"
      @touchend="startAutoplay"
    >
      <!-- 第一页：涨跌分布（参照用户图片样式） -->
      <van-swipe-item>
        <div class="swipe-card">
                    <div class="card-header">
            <span class="card-title">大盘涨跌分布</span>
            <span class="update-time" v-if="marketOverview">更新: {{ marketOverview.updateTime }}</span>
          </div>
          <div class="distribution-chart" v-if="marketOverview">
            <!-- 柱状图 -->
            <div class="chart-bars">
              <div 
                v-for="item in marketOverview.distribution" 
                :key="item.range"
                class="bar-item"
                @click="onDistributionClick(item)"
              >
                <div class="bar-value">{{ item.count || '' }}</div>
                <div 
                  class="bar" 
                  :class="getBarColor(item.range)"
                  :style="{ height: `${(item.count / maxDistCount) * 100}px` }"
                ></div>
                <div class="bar-label">{{ item.range }}</div>
              </div>
            </div>
            <!-- 涨跌统计 -->
            <div class="stats-row">
              <span class="stat-item">
                <span class="stat-label">下跌</span>
                <span class="stat-value down">{{ marketOverview.totalDown }}家</span>
              </span>
              <span class="stat-item">
                <span class="stat-label">平家</span>
                <span class="stat-value flat">{{ marketOverview.distribution.find(d => d.range === '0~1')?.count ?? 0 }}家</span>
              </span>
              <span class="stat-item">
                <span class="stat-label">上涨</span>
                <span class="stat-value up">{{ marketOverview.totalUp }}家</span>
              </span>
            </div>
          </div>
          <van-loading v-else class="loading-box" />
        </div>
      </van-swipe-item>

      <!-- 第二页：基金涨跌分布 -->
      <van-swipe-item>
        <div class="swipe-card">
                    <div class="card-header">
            <span class="card-title">基金涨跌分布</span>
            <span class="update-time" v-if="fundOverview">更新: {{ fundOverview.updateTime }}</span>
          </div>
          <div class="distribution-chart" v-if="fundOverview">
            <!-- 柱状图 -->
            <div class="chart-bars">
              <div 
                v-for="item in fundOverview.distribution" 
                :key="item.range"
                class="bar-item"
                @click="onDistributionClick(item)"
              >
                <div class="bar-value">{{ item.count || '' }}</div>
                <div 
                  class="bar" 
                  :class="getBarColor(item.range)"
                  :style="{ height: `${(item.count / maxFundDistCount) * 100}px` }"
                ></div>
                <div class="bar-label">{{ item.range }}</div>
              </div>
            </div>
            <!-- 涨跌统计条 -->
            <div class="updown-bar">
              <div class="down-section">
                <span class="label">下跌</span>
                <span class="count">{{ fundOverview.totalDown }}</span>
              </div>
              <div 
                class="progress-bar"
                :style="{ 
                  background: `linear-gradient(to right, var(--color-down) ${fundOverview.totalDown / (fundOverview.totalDown + fundOverview.totalUp) * 100}%, var(--color-up) ${fundOverview.totalDown / (fundOverview.totalDown + fundOverview.totalUp) * 100}%)`
                }"
              ></div>
              <div class="up-section">
                <span class="count">{{ fundOverview.totalUp }}</span>
                <span class="label">上涨</span>
              </div>
            </div>
          </div>
          <van-loading v-else class="loading-box" />
        </div>
      </van-swipe-item>

      <!-- 第三页：板块资金流向 -->
      <van-swipe-item>
        <div class="swipe-card" @click="goToMarket">
                    <div class="card-header">
            <span class="card-title">板块资金流向</span>
            <span class="update-time" v-if="fundOverview">更新: {{ fundOverview.updateTime }}</span>
          </div>
          <div class="sector-flow">
            <div class="flow-section inflow">
              <div class="flow-title">流入</div>
              <div class="flow-list">
                <div v-for="(item, index) in sectorFlowStats.inflow" :key="index" class="flow-item">
                  <span class="flow-rank">{{ index + 1 }}</span>
                  <span class="flow-name">{{ item.name }}</span>
                  <span class="flow-change" :class="getChangeStatus(item.dayReturn)">
                    {{ formatPercent(item.dayReturn) }}
                  </span>
                </div>
              </div>
            </div>
            <div class="flow-section outflow">
              <div class="flow-title">流出</div>
              <div class="flow-list">
                <div v-for="(item, index) in sectorFlowStats.outflow" :key="index" class="flow-item">
                  <span class="flow-rank">{{ index + 1 }}</span>
                  <span class="flow-name">{{ item.name }}</span>
                  <span class="flow-change" :class="getChangeStatus(item.dayReturn)">
                    {{ formatPercent(item.dayReturn) }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </van-swipe-item>
    </van-swipe>
  </div>
</template>

<style scoped>
.market-swiper-container {
  margin: 0 0 12px 0;
  background: var(--bg-secondary);
}

.market-swipe {
  height: 240px;
}

.swipe-card {
  height: 100%;
  padding: 14px 16px;
  box-sizing: border-box;
  cursor: pointer;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.update-time {
  font-size: 12px;
  color: var(--text-muted);
}

/* ========== 涨跌分布（参照用户图片样式） ========== */
.distribution-chart {
  height: calc(100% - 30px);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.chart-bars {
  flex: 1;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  padding: 0 4px;
}

.bar-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
  cursor: pointer;
  padding: 4px 2px;
  border-radius: 4px;
  transition: background 0.2s;
}

.bar-item:active {
  background: var(--bg-card-hover);
}

.bar-value {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  min-height: 16px;
  font-weight: 500;
}

.bar {
  width: 28px;
  min-height: 4px;
  border-radius: 2px 2px 0 0;
  transition: height 0.3s;
}

.bar.down { background: #22c55e; }
.bar.up { background: #ef4444; }
.bar.neutral { background: var(--text-muted); }

.bar-label {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 6px;
  white-space: nowrap;
}

/* 涨跌统计行（参照图片底部样式） */
.stats-row {
  display: flex;
  justify-content: space-between;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.stat-label {
  font-size: 13px;
  color: var(--text-secondary);
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
}

.stat-value.up { color: #ef4444; }
.stat-value.down { color: #22c55e; }
.stat-value.flat { color: var(--text-secondary); }

/* ========== 基金涨跌分布 ========== */
.updown-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.down-section, .up-section {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  white-space: nowrap;
}

.down-section .label { color: var(--color-down); }
.down-section .count { color: var(--color-down); font-weight: 600; }
.up-section .label { color: var(--color-up); }
.up-section .count { color: var(--color-up); font-weight: 600; }

.progress-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
}

/* ========== 板块资金流向 ========== */
.sector-flow {
  height: calc(100% - 30px);
  display: flex;
  gap: 16px;
}

.flow-section {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.flow-title {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 8px;
}

.inflow .flow-title { color: var(--color-up); }
.outflow .flow-title { color: var(--color-down); }

.flow-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.flow-item {
  display: flex;
  align-items: center;
  font-size: 13px;
}

.flow-rank {
  width: 18px;
  color: var(--text-secondary);
}

.flow-name {
  flex: 1;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flow-change {
  font-weight: 500;
  margin-left: 8px;
}

.flow-change.up { color: var(--color-up); }
.flow-change.down { color: var(--color-down); }
.flow-change.flat { color: var(--text-secondary); }

/* ========== 通用 ========== */
.loading-box {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 移动端适配 */
@media (max-width: 360px) {
  .bar {
    width: 22px;
  }
  
  .bar-label {
    font-size: 9px;
  }
  
  .stat-value {
    font-size: 13px;
  }
  
  .stat-label {
    font-size: 12px;
  }
}
</style>
