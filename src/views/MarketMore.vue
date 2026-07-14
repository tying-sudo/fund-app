<script setup lang="ts">
// [WHAT] 行情更多页面 - 展示完整的场外基金/板块/ETF列表
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchOTCFundRank, fetchSectorFunds, fetchETFRank,
  type OTCFundItem, type SectorInfo, type ETFItem
} from '@/api/tiantianApi'
import { formatPercent, getChangeStatus, getJdFundLink } from '@/utils/format'
import { showToast } from 'vant'

const route = useRoute()
const router = useRouter()

// [WHAT] 当前类型：otc / sector / etf
const currentType = computed(() => (route.query.type as string) || 'otc')

// [WHAT] 页面标题
const pageTitle = computed(() => {
  const titles: Record<string, string> = {
    otc: '场外基金涨幅榜',
    sector: '板块总览',
    etf: '场内ETF涨幅榜'
  }
  return titles[currentType.value] || '行情'
})

// ========== 数据 ==========
const otcFunds = ref<OTCFundItem[]>([])
const sectors = ref<SectorInfo[]>([])
const etfList = ref<ETFItem[]>([])
const loading = ref(true)
const isRefreshing = ref(false)

// [WHAT] 排序方式（仅场外基金）
const sortOrder = ref<'desc' | 'asc'>('desc')

// [WHAT] 加载数据
async function loadData() {
  loading.value = true
  try {
    if (currentType.value === 'otc') {
      otcFunds.value = await fetchOTCFundRank(sortOrder.value, 50)
    } else if (currentType.value === 'sector') {
      // [WHAT] 板块总览页面获取更多板块（30个）
      sectors.value = await fetchSectorFunds(30)
    } else if (currentType.value === 'etf') {
      etfList.value = await fetchETFRank(50)
    }
  } catch {
    // 静默失败
  } finally {
    loading.value = false
  }
}

// [WHAT] 切换排序
function toggleSort() {
  sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc'
  loadData()
}

// [WHAT] 下拉刷新
async function onRefresh() {
  isRefreshing.value = true
  try {
    await loadData()
    showToast('刷新成功')
  } finally {
    isRefreshing.value = false
  }
}

// [WHAT] 跳转到基金详情
function goToDetail(code: string) {
  router.push(`/detail/${code}`)
}

// [WHAT] 显示板块详情弹窗
const showSectorPopup = ref(false)
const selectedSector = ref<SectorInfo | null>(null)

function goToSector(sector: SectorInfo) {
  selectedSector.value = sector
  showSectorPopup.value = true
}

// [WHAT] 板块名称到搜索关键词的映射
const sectorSearchKeywords: Record<string, string[]> = {
  // 半导体/芯片相关
  '模拟芯片设计': ['芯片', '半导体', '集成电路'],
  '数字芯片设计': ['芯片', '半导体', '集成电路'],
  '芯片': ['芯片', '半导体', '集成电路'],
  '半导体': ['芯片', '半导体', '集成电路'],
  '集成电路': ['芯片', '半导体', '集成电路'],
  '分立器件': ['芯片', '半导体'],
  '集成电路封测': ['芯片', '半导体', '封测'],
  
  // 光学/电子相关
  '光学元件': ['光学', '光电子', '光电'],
  '光学光电子': ['光学', '光电子', '光电'],
  '光电子': ['光学', '光电子', '光电'],
  '面板': ['面板', '显示', 'OLED'],
  '显示': ['面板', '显示', 'OLED'],
  
  // 新能源相关
  '光伏': ['光伏', '太阳能', '新能源'],
  '太阳能': ['光伏', '太阳能', '新能源'],
  '新能源': ['新能源', '光伏', '锂电'],
  '锂电': ['新能源', '锂电', '电池'],
  '电池': ['新能源', '锂电', '电池'],
  
  // 消费/医药相关
  '白酒': ['白酒', '消费'],
  '消费': ['消费', '白酒'],
  '医药': ['医药', '医疗', '健康'],
  '医疗': ['医药', '医疗', '健康'],
  '中药': ['中药', '医药'],
  
  // 科技/互联网相关
  '人工智能': ['人工智能', 'AI', '科技'],
  'AI': ['人工智能', 'AI', '科技'],
  '机器人': ['机器人', '人工智能', '自动化'],
  '互联网': ['互联网', '科技', '传媒'],
  '传媒': ['传媒', '互联网', '文化'],
  
  // 金融/地产相关
  '银行': ['银行', '金融'],
  '证券': ['证券', '券商', '金融'],
  '券商': ['证券', '券商', '金融'],
  '保险': ['保险', '金融'],
  '房地产': ['房地产', '地产'],
  '地产': ['房地产', '地产'],
  
  // 军工/航空相关
  '军工': ['军工', '国防', '航天'],
  '航天': ['军工', '航天', '航空'],
  '航空': ['军工', '航空', '航天'],
  
  // 其他行业
  '汽车': ['汽车', '新能源车'],
  '新能源车': ['新能源车', '汽车', '电动车'],
  '煤炭': ['煤炭', '能源'],
  '钢铁': ['钢铁', '黑色金属'],
  '有色金属': ['有色金属', '金属'],
  '化工': ['化工', '化学'],
  '建材': ['建材', '建筑'],
  '建筑': ['建材', '建筑'],
  '交通运输': ['交通运输', '物流', '航空'],
  '食品饮料': ['食品饮料', '消费'],
  '农林牧渔': ['农业', '养殖', '种植'],
  '电力设备': ['电力设备', '电气', '新能源'],
  '计算机': ['计算机', '软件', '科技'],
  '通信': ['通信', '5G', '科技'],
  '电子': ['电子', '半导体', '科技'],
  '机械设备': ['机械设备', '机械', '自动化'],
  '公用事业': ['公用事业', '电力', '水务'],
}

// [WHAT] 搜索板块相关基金
function searchSectorFunds() {
  if (!selectedSector.value) return
  showSectorPopup.value = false
  
  // 获取板块名称
  const sectorName = selectedSector.value.name
  
  // 查找匹配的搜索关键词
  let searchKeywords = sectorSearchKeywords[sectorName]
  
  // 如果没有精确匹配，尝试模糊匹配
  if (!searchKeywords) {
    for (const [key, keywords] of Object.entries(sectorSearchKeywords)) {
      if (sectorName.includes(key) || key.includes(sectorName)) {
        searchKeywords = keywords
        break
      }
    }
  }
  
  // 如果还是没有匹配，使用板块名称本身
  const searchQuery = searchKeywords ? searchKeywords[0] : sectorName
  
  router.push({ path: '/search', query: { q: searchQuery } })
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="market-more-page">
    <!-- 顶部导航 -->
    <van-nav-bar :title="pageTitle" left-arrow @click-left="router.back()">
      <template #right>
        <!-- 场外基金显示排序切换 -->
        <van-icon v-if="currentType === 'otc'" name="sort" size="18" @click="toggleSort" />
      </template>
    </van-nav-bar>

    <van-pull-refresh v-model="isRefreshing" @refresh="onRefresh" class="content-area">
      <!-- 场外基金列表 -->
      <div v-if="currentType === 'otc'" class="fund-list">
        <div 
          v-for="(fund, idx) in otcFunds" 
          :key="fund.code"
          class="fund-item"
          @click="goToDetail(fund.code)"
        >
          <div class="rank-num" :class="{ top3: idx < 3 }">{{ idx + 1 }}</div>
          <div class="fund-info">
            <div class="fund-name">{{ fund.name }}</div>
            <div class="fund-meta">
              <span class="update-tag">{{ fund.updateStatus }}</span>
              <a class="fund-code" :href="getJdFundLink(fund.code)" @click.stop>{{ fund.code }}</a>
            </div>
          </div>
          <div class="fund-value">{{ fund.netValue.toFixed(4) }}</div>
          <div class="fund-change" :class="getChangeStatus(fund.dayReturn)">
            {{ formatPercent(fund.dayReturn) }}
          </div>
        </div>
        <van-empty v-if="!loading && otcFunds.length === 0" description="暂无数据" />
      </div>

      <!-- 板块列表 -->
      <div v-if="currentType === 'sector'" class="sector-list">
        <div 
          v-for="(sector, idx) in sectors" 
          :key="sector.code || sector.name"
          class="sector-item"
          @click="goToSector(sector)"
        >
          <div class="rank-num" :class="{ top3: idx < 3 }">{{ idx + 1 }}</div>
          <div class="sector-info">
            <div class="sector-name">{{ sector.name }}</div>
            <div class="sector-meta" v-if="sector.streak">{{ sector.streak }}</div>
          </div>
          <div class="sector-change" :class="getChangeStatus(sector.dayReturn)">
            {{ formatPercent(sector.dayReturn) }}
          </div>
          <van-icon name="arrow" class="sector-arrow" />
        </div>
        <van-empty v-if="!loading && sectors.length === 0" description="暂无数据" />
      </div>

      <!-- ETF列表 -->
      <div v-if="currentType === 'etf'" class="etf-list">
        <div 
          v-for="(etf, idx) in etfList" 
          :key="etf.code"
          class="etf-item"
          @click="goToDetail(etf.code)"
        >
          <div class="rank-num" :class="{ top3: idx < 3 }">{{ idx + 1 }}</div>
          <div class="etf-info">
            <div class="etf-name">{{ etf.name }}</div>
            <div class="etf-code">{{ etf.code }}</div>
          </div>
          <div class="etf-price">{{ etf.price.toFixed(4) }}</div>
          <div class="etf-change" :class="getChangeStatus(etf.dayReturn)">
            {{ formatPercent(etf.dayReturn) }}
          </div>
        </div>
        <van-empty v-if="!loading && etfList.length === 0" description="暂无数据" />
      </div>

      <van-loading v-if="loading" class="loading-box" />
    </van-pull-refresh>

    <!-- 板块详情弹窗 -->
    <van-popup 
      v-model:show="showSectorPopup" 
      position="bottom" 
      round
      :style="{ maxHeight: '60%' }"
    >
      <div class="sector-popup" v-if="selectedSector">
        <div class="sector-popup-header">
          <div class="sector-popup-title">{{ selectedSector.name }}</div>
          <van-icon name="cross" @click="showSectorPopup = false" />
        </div>
        
        <div class="sector-popup-content">
          <div class="sector-popup-info">
            <div class="info-row">
              <span class="label">今日涨幅</span>
              <span class="value" :class="getChangeStatus(selectedSector.dayReturn)">
                {{ formatPercent(selectedSector.dayReturn) }}
              </span>
            </div>
            <div class="info-row" v-if="selectedSector.streak">
              <span class="label">连续表现</span>
              <span class="value streak">{{ selectedSector.streak }}</span>
            </div>
          </div>
          
          <div class="sector-popup-actions">
            <van-button type="primary" block round @click="searchSectorFunds">
              搜索相关基金
            </van-button>
          </div>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.market-more-page {
  min-height: 100vh;
  background: var(--bg-primary);
}

.content-area {
  height: calc(100vh - 46px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

/* ========== 排名数字 ==========
.rank-num {
  width: 24px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-muted);
  text-align: center;
  flex-shrink: 0;
}

.rank-num.top3 {
  color: var(--color-primary);
  font-weight: 700;
}

/* ========== 场外基金 ========== */
.fund-list {
  padding: 0;
}

.fund-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
}

.fund-item:active {
  background: var(--bg-tertiary);
}

.fund-info {
  flex: 1;
  min-width: 0;
}

.fund-name {
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fund-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.update-tag {
  font-size: 10px;
  padding: 1px 4px;
  background: var(--color-primary);
  color: #fff;
  border-radius: 2px;
}

.fund-code {
  font-size: 12px;
  color: var(--text-muted);
}

.fund-value {
  width: 70px;
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  text-align: right;
  font-family: -apple-system, 'SF Mono', monospace;
}

.fund-change {
  width: 70px;
  font-size: 15px;
  font-weight: 600;
  text-align: right;
  font-family: -apple-system, 'SF Mono', monospace;
}

.fund-change.up { color: var(--color-up); }
.fund-change.down { color: var(--color-down); }
.fund-change.flat { color: var(--text-secondary); }

/* ========== 板块列表 ========== */
.sector-list {
  padding: 0;
}

.sector-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  transition: background 0.15s;
}

.sector-item:active {
  background: var(--bg-secondary);
}

.sector-arrow {
  color: var(--text-secondary);
  margin-left: 8px;
}

.sector-info {
  flex: 1;
}

.sector-name {
  font-size: 15px;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.sector-meta {
  font-size: 12px;
  color: var(--color-up);
}

.sector-change {
  font-size: 15px;
  font-weight: 600;
  font-family: -apple-system, 'SF Mono', monospace;
}

.sector-change.up { color: var(--color-up); }
.sector-change.down { color: var(--color-down); }
.sector-change.flat { color: var(--text-secondary); }

/* ========== ETF列表 ========== */
.etf-list {
  padding: 0;
}

.etf-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
}

.etf-item:active {
  background: var(--bg-tertiary);
}

.etf-info {
  flex: 1;
  min-width: 0;
}

.etf-name {
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.etf-code {
  font-size: 12px;
  color: var(--text-muted);
}

.etf-price {
  width: 70px;
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  text-align: right;
  font-family: -apple-system, 'SF Mono', monospace;
}

.etf-change {
  width: 70px;
  font-size: 15px;
  font-weight: 600;
  text-align: right;
  font-family: -apple-system, 'SF Mono', monospace;
}

.etf-change.up { color: var(--color-up); }
.etf-change.down { color: var(--color-down); }
.etf-change.flat { color: var(--text-secondary); }

/* ========== 通用 ========== */
.loading-box {
  padding: 40px 0;
  text-align: center;
}

/* ========== 板块弹窗 ========== */
.sector-popup {
  padding: 20px;
}

.sector-popup-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.sector-popup-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.sector-popup-info {
  margin-bottom: 20px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);
}

.info-row:last-child {
  border-bottom: none;
}

.info-row .label {
  color: var(--text-secondary);
  font-size: 14px;
}

.info-row .value {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
}

.info-row .value.streak {
  color: var(--color-up);
}

.sector-popup-actions {
  padding-top: 10px;
}
</style>
