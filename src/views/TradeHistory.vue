<script setup lang="ts">
// [WHY] 交易记录页面 - 展示和管理所有交易记录
// [WHAT] 显示交易列表、添加新交易、统计信息

import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useTradeStore } from '@/stores/trade'
import { searchFund, fetchFundEstimate } from '@/api/fund'
import { formatMoney } from '@/utils/format'
import { showConfirmDialog, showToast, showLoadingToast, closeToast } from 'vant'
import type { TradeType, FundInfo } from '@/types/fund'
import { TRADE_TYPE_CONFIG } from '@/types/fund'

const router = useRouter()
const tradeStore = useTradeStore()

// ========== 筛选相关 ==========
const filterType = ref<TradeType | 'all'>('all')
const filterTypes = [
  { key: 'all', label: '全部' },
  { key: 'buy', label: '买入' },
  { key: 'sell', label: '卖出' },
  { key: 'dividend', label: '分红' },
  { key: 'auto_invest', label: '定投' }
]

// [WHAT] 过滤后的交易记录
const filteredTrades = computed(() => {
  if (filterType.value === 'all') {
    return tradeStore.sortedTrades
  }
  return tradeStore.sortedTrades.filter(t => t.type === filterType.value)
})

// ========== 添加交易弹窗 ==========
const showAddDialog = ref(false)
const tradeForm = ref({
  code: '',
  name: '',
  type: 'buy' as TradeType,
  date: new Date().toISOString().split('T')[0],
  amount: '',
  netValue: '',
  shares: '',
  fee: '0',
  remark: ''
})

// 基金搜索相关
const searchKeyword = ref('')
const searchResults = ref<FundInfo[]>([])
const selectedFund = ref<FundInfo | null>(null)
const currentNetValue = ref(0)

// [WHAT] 搜索基金
let searchTimer: ReturnType<typeof setTimeout> | null = null
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  if (!searchKeyword.value.trim()) {
    searchResults.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    searchResults.value = await searchFund(searchKeyword.value, 10)
  }, 300)
}

// [WHAT] 选择基金
async function selectFund(fund: FundInfo) {
  selectedFund.value = fund
  tradeForm.value.code = fund.code
  tradeForm.value.name = fund.name
  searchKeyword.value = ''
  searchResults.value = []
  
  // 获取当前净值
  showLoadingToast({ message: '获取净值...', forbidClick: true })
  try {
    const estimate = await fetchFundEstimate(fund.code)
    currentNetValue.value = parseFloat(estimate.gsz) || parseFloat(estimate.dwjz) || 0
    tradeForm.value.netValue = currentNetValue.value.toFixed(4)
    closeToast()
  } catch {
    closeToast()
  }
}

// [WHAT] 计算份额
const calculatedShares = computed(() => {
  const amount = parseFloat(tradeForm.value.amount) || 0
  const netValue = parseFloat(tradeForm.value.netValue) || 0
  if (amount <= 0 || netValue <= 0) return 0
  return amount / netValue
})

// [WHAT] 打开添加弹窗
function openAddDialog(type: TradeType = 'buy') {
  tradeForm.value = {
    code: '',
    name: '',
    type,
    date: new Date().toISOString().split('T')[0],
    amount: '',
    netValue: '',
    shares: '',
    fee: '0',
    remark: ''
  }
  selectedFund.value = null
  searchKeyword.value = ''
  searchResults.value = []
  showAddDialog.value = true
}

// [WHAT] 提交交易
function submitTrade() {
  if (!tradeForm.value.code) {
    showToast('请选择基金')
    return
  }
  if (!tradeForm.value.amount || parseFloat(tradeForm.value.amount) <= 0) {
    showToast('请输入有效金额')
    return
  }
  if (!tradeForm.value.netValue || parseFloat(tradeForm.value.netValue) <= 0) {
    showToast('请输入有效净值')
    return
  }

  const amount = parseFloat(tradeForm.value.amount)
  const netValue = parseFloat(tradeForm.value.netValue)
  const fee = parseFloat(tradeForm.value.fee) || 0

  if (tradeForm.value.type === 'sell') {
    // 卖出时按份额计算
    const shares = parseFloat(tradeForm.value.shares) || calculatedShares.value
    tradeStore.addSellTrade({
      code: tradeForm.value.code,
      name: tradeForm.value.name,
      date: tradeForm.value.date,
      shares,
      netValue,
      fee,
      remark: tradeForm.value.remark
    })
  } else if (tradeForm.value.type === 'dividend') {
    tradeStore.addDividendTrade({
      code: tradeForm.value.code,
      name: tradeForm.value.name,
      date: tradeForm.value.date,
      amount,
      remark: tradeForm.value.remark
    })
  } else {
    tradeStore.addBuyTrade({
      code: tradeForm.value.code,
      name: tradeForm.value.name,
      date: tradeForm.value.date,
      amount,
      netValue,
      fee,
      remark: tradeForm.value.remark
    })
  }

  showToast('添加成功')
  showAddDialog.value = false
}

// [WHAT] 删除交易记录
async function handleDelete(id: string) {
  try {
    await showConfirmDialog({
      title: '确认删除',
      message: '确定要删除这条交易记录吗？'
    })
    tradeStore.deleteTrade(id)
    showToast('已删除')
  } catch {
    // 用户取消
  }
}

// [WHAT] 返回
function goBack() {
  router.back()
}

// [WHAT] 获取交易类型配置
function getTypeConfig(type: TradeType) {
  return TRADE_TYPE_CONFIG[type]
}
</script>

<template>
  <div class="trade-page">
    <!-- 顶部导航 -->
    <van-nav-bar title="交易记录" left-arrow @click-left="goBack">
      <template #right>
        <van-icon name="add-o" size="20" @click="openAddDialog('buy')" />
      </template>
    </van-nav-bar>

    <!-- 统计卡片 -->
    <div class="stats-card">
      <div class="stats-row">
        <div class="stat-item">
          <span class="stat-label">累计买入</span>
          <span class="stat-value buy">{{ formatMoney(tradeStore.statistics.totalBuy) }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">累计卖出</span>
          <span class="stat-value sell">{{ formatMoney(tradeStore.statistics.totalSell) }}</span>
        </div>
      </div>
      <div class="stats-row">
        <div class="stat-item">
          <span class="stat-label">累计分红</span>
          <span class="stat-value dividend">{{ formatMoney(tradeStore.statistics.totalDividend) }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">累计手续费</span>
          <span class="stat-value fee">{{ formatMoney(tradeStore.statistics.totalFee) }}</span>
        </div>
      </div>
    </div>

    <!-- 筛选标签 -->
    <div class="filter-tabs">
      <div
        v-for="f in filterTypes"
        :key="f.key"
        class="filter-tab"
        :class="{ active: filterType === f.key }"
        @click="filterType = f.key as TradeType | 'all'"
      >
        {{ f.label }}
      </div>
    </div>

    <!-- 交易列表 -->
    <div class="trade-list">
      <template v-if="filteredTrades.length > 0">
        <van-swipe-cell v-for="trade in filteredTrades" :key="trade.id">
          <div class="trade-item">
            <div class="trade-left">
              <div class="trade-type" :style="{ color: getTypeConfig(trade.type).color }">
                {{ getTypeConfig(trade.type).label }}
              </div>
              <div class="trade-fund">{{ trade.name }}</div>
              <div class="trade-date">{{ trade.date }}</div>
            </div>
            <div class="trade-right">
              <div class="trade-amount" :class="trade.type">
                {{ trade.type === 'sell' ? '+' : '-' }}{{ formatMoney(trade.amount) }}
              </div>
              <div class="trade-detail">
                {{ trade.shares.toFixed(2) }}份 · {{ trade.netValue.toFixed(4) }}
              </div>
            </div>
          </div>
          <template #right>
            <van-button square type="danger" text="删除" @click="handleDelete(trade.id)" />
          </template>
        </van-swipe-cell>
      </template>
      <van-empty v-else description="暂无交易记录">
        <van-button round type="primary" size="small" @click="openAddDialog('buy')">
          添加交易
        </van-button>
      </van-empty>
    </div>

    <!-- 快捷操作按钮 -->
    <div class="quick-actions">
      <van-button type="danger" round size="small" @click="openAddDialog('buy')">买入</van-button>
      <van-button type="success" round size="small" @click="openAddDialog('sell')">卖出</van-button>
      <van-button type="warning" round size="small" @click="openAddDialog('dividend')">分红</van-button>
      <van-button type="primary" round size="small" @click="openAddDialog('auto_invest')">定投</van-button>
    </div>

    <!-- 添加交易弹窗 -->
    <van-popup v-model:show="showAddDialog" position="bottom" round :style="{ height: '80%' }">
      <div class="add-dialog">
        <div class="dialog-header">
          <span>{{ getTypeConfig(tradeForm.type).label }}记录</span>
          <van-icon name="cross" @click="showAddDialog = false" />
        </div>

        <div class="dialog-content">
          <!-- 交易类型 -->
          <van-field label="交易类型">
            <template #input>
              <van-radio-group v-model="tradeForm.type" direction="horizontal">
                <van-radio name="buy">买入</van-radio>
                <van-radio name="sell">卖出</van-radio>
                <van-radio name="dividend">分红</van-radio>
                <van-radio name="auto_invest">定投</van-radio>
              </van-radio-group>
            </template>
          </van-field>

          <!-- 选择基金 -->
          <van-field
            v-if="!selectedFund"
            v-model="searchKeyword"
            label="选择基金"
            placeholder="输入基金代码或名称"
            @input="onSearchInput"
          />
          <div v-if="searchResults.length > 0" class="search-results">
            <van-cell
              v-for="fund in searchResults"
              :key="fund.code"
              :title="fund.name"
              :label="fund.code"
              clickable
              @click="selectFund(fund)"
            />
          </div>
          <van-field
            v-if="selectedFund"
            :model-value="`${selectedFund.name} (${selectedFund.code})`"
            label="已选基金"
            readonly
          >
            <template #button>
              <van-button size="small" @click="selectedFund = null">重选</van-button>
            </template>
          </van-field>

          <!-- 交易日期 -->
          <van-field v-model="tradeForm.date" label="交易日期" type="date" />

          <!-- 金额/份额 -->
          <van-field
            v-model="tradeForm.amount"
            :label="tradeForm.type === 'sell' ? '卖出金额' : tradeForm.type === 'dividend' ? '分红金额' : '买入金额'"
            type="number"
            placeholder="请输入金额"
          />

          <!-- 净值（分红不需要） -->
          <van-field
            v-if="tradeForm.type !== 'dividend'"
            v-model="tradeForm.netValue"
            label="成交净值"
            type="number"
            placeholder="请输入净值"
          />

          <!-- 手续费（分红不需要） -->
          <van-field
            v-if="tradeForm.type !== 'dividend'"
            v-model="tradeForm.fee"
            label="手续费"
            type="number"
            placeholder="0"
          />

          <!-- 计算结果 -->
          <div v-if="calculatedShares > 0 && tradeForm.type !== 'dividend'" class="calc-result">
            <span>预估份额：{{ calculatedShares.toFixed(2) }} 份</span>
          </div>

          <!-- 备注 -->
          <van-field
            v-model="tradeForm.remark"
            label="备注"
            placeholder="可选"
          />
        </div>

        <div class="dialog-footer">
          <van-button block type="primary" @click="submitTrade">确认添加</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.trade-page {
  min-height: 100vh;
  background: var(--bg-primary);
  padding-bottom: 80px;
  transition: background-color 0.3s;
}

/* 统计卡片 */
.stats-card {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  margin: 12px;
  padding: 16px;
  border-radius: 12px;
  color: #fff;
}

.stats-row {
  display: flex;
  justify-content: space-around;
  margin-bottom: 12px;
}

.stats-row:last-child {
  margin-bottom: 0;
}

.stat-item {
  text-align: center;
}

.stat-label {
  display: block;
  font-size: 12px;
  opacity: 0.8;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
}

/* 筛选标签 */
.filter-tabs {
  display: flex;
  gap: 8px;
  padding: 12px;
  background: var(--bg-secondary);
  overflow-x: auto;
}

.filter-tab {
  padding: 6px 16px;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 16px;
  white-space: nowrap;
}

.filter-tab.active {
  color: #fff;
  background: var(--color-primary);
}

/* 交易列表 */
.trade-list {
  background: var(--bg-secondary);
}

.trade-item {
  display: flex;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.trade-left {
  flex: 1;
}

.trade-type {
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 4px;
}

.trade-fund {
  font-size: 15px;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.trade-date {
  font-size: 12px;
  color: var(--text-secondary);
}

.trade-right {
  text-align: right;
}

.trade-amount {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}

.trade-amount.buy,
.trade-amount.auto_invest { color: var(--color-up); }
.trade-amount.sell { color: var(--color-down); }
.trade-amount.dividend { color: #ff9800; }

.trade-detail {
  font-size: 12px;
  color: var(--text-secondary);
}

/* 快捷操作 */
.quick-actions {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-around;
  padding: 12px 16px;
  background: var(--bg-secondary);
  box-shadow: 0 -2px 10px rgba(0,0,0,0.1);
}

/* 添加弹窗 */
.add-dialog {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.dialog-content {
  flex: 1;
  overflow-y: auto;
}

.search-results {
  max-height: 200px;
  overflow-y: auto;
  border-bottom: 1px solid var(--border-color);
}

.calc-result {
  padding: 12px 16px;
  background: var(--bg-tertiary);
  margin: 0 16px;
  border-radius: 8px;
  font-size: 14px;
  color: var(--color-primary);
}

.dialog-footer {
  padding: 16px;
}
</style>
