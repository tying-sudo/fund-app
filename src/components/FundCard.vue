<script setup lang="ts">
// [WHY] 基金卡片组件，用于展示单只基金的实时估值
// [WHAT] 显示基金名称、代码、类型、估值、涨跌幅，支持价格闪烁效果
// [HOW] 支持点击跳转、右滑删除、长按设置提醒

import type { WatchlistItem, DataSource } from '@/types/fund'
import { DATA_SOURCE_CONFIG } from '@/types/fund'
import { formatNetValue, formatPercent, getChangeStatus, getJdFundLink } from '@/utils/format'
import { computed, ref, watch, onMounted } from 'vue'
import { fetchNetValueHistoryFast } from '@/api/fundFast'

const props = defineProps<{
  fund: WatchlistItem
}>()

const emit = defineEmits<{
  delete: [code: string]
  click: [code: string]
  longpress: []
  sourceSelect: [code: string]
}>()

// [WHAT] 价格闪烁状态（模仿交易所效果）
const flashClass = ref('')
const prevValue = ref(0)

// [WHAT] 监听价格变化，触发闪烁动画
watch(() => props.fund.estimateValue, (newVal, oldVal) => {
  const newNum = typeof newVal === 'string' ? parseFloat(newVal) : (newVal || 0)
  const oldNum = typeof oldVal === 'string' ? parseFloat(oldVal) : (oldVal || 0)
  
  if (newNum !== oldNum && oldNum !== 0) {
    flashClass.value = newNum > oldNum ? 'flash-up' : 'flash-down'
    setTimeout(() => {
      flashClass.value = ''
    }, 500)
  }
  prevValue.value = oldNum
})

// [WHAT] 根据涨跌状态返回对应的 CSS 类名
const changeClass = computed(() => {
  if (!props.fund.estimateChange || props.fund.estimateChange === '--') return ''
  return getChangeStatus(props.fund.estimateChange)
})

const displayChange = computed(() => {
  // [EDGE] 估值为"--"时直接显示"--"，不格式化
  if (props.fund.estimateChange === '--') return '--'
  return formatPercent(props.fund.estimateChange || 0)
})

const displayValue = computed(() => {
  const val = props.fund.estimateValue
  // [FIX] 值为0或无效时显示"--"，避免夜间显示0.0000
  if (!val || val === '0' || val === '0.0000' || val === '--') return '--'
  return formatNetValue(val)
})

// [WHAT] 主显示区净值：盘后机构公布真实涨跌幅后，切换为真实净值
// [WHY] 与持仓页逻辑对齐：真实数据优先，估值作为兜底
const displayNetValue = computed(() => {
  if (props.fund.isRealChangeToday && props.fund.realChange !== undefined && props.fund.realChange !== null) {
    const lastValue = parseFloat(props.fund.lastValue || '0')
    if (lastValue > 0) {
      const realValue = lastValue * (1 + props.fund.realChange / 100)
      return formatNetValue(realValue.toFixed(4))
    }
  }
  return displayValue.value
})

// [WHAT] 主显示区涨跌幅：盘后切换为真实涨跌幅
const displayMainChange = computed(() => {
  if (props.fund.isRealChangeToday && props.fund.realChange !== undefined && props.fund.realChange !== null) {
    return formatPercent(props.fund.realChange)
  }
  return displayChange.value
})

// [WHAT] 主显示区涨跌颜色类
const mainChangeClass = computed(() => {
  if (props.fund.isRealChangeToday && props.fund.realChange !== undefined && props.fund.realChange !== null) {
    return getChangeStatus(props.fund.realChange)
  }
  return changeClass.value
})

// [WHAT] 京东金融跳转链接
const jdFundLink = computed(() => {
  return getJdFundLink(props.fund.code)
})

// [WHAT] 长按检测
let pressTimer: ReturnType<typeof setTimeout> | null = null

function onTouchStart() {
  pressTimer = setTimeout(() => {
    emit('longpress')
  }, 500) // 长按500ms触发
}

function onTouchEnd() {
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

function onTouchMove() {
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

// [WHAT] 判断当前是否为交易时段（盘中）
const isTradingHours = computed(() => {
  const now = new Date()
  const day = now.getDay() // 0=周日, 1-5=周一至周五, 6=周六
  const hours = now.getHours()
  const minutes = now.getMinutes()
  const currentTime = hours * 60 + minutes // 转换为分钟数
  
  // 周末不交易
  if (day === 0 || day === 6) return false
  
  // 交易时段: 9:30-15:00
  const marketOpen = 9 * 60 + 30 // 9:30
  const marketClose = 15 * 60 // 15:00
  
  return currentTime >= marketOpen && currentTime < marketClose
})

// [WHAT] 状态标签文本
// 根据机构是否公布今日真实涨跌幅来判断：
// - true（机构已公布）：显示"已更新"
// - false（机构未公布）：显示"待更新"
const statusTag = computed(() => {
  return props.fund.isRealChangeToday ? '已更新' : '待更新'
})

// [WHAT] 状态标签样式类
const statusTagClass = computed(() => {
  return props.fund.isRealChangeToday ? 'tag-updated' : 'tag-trading'
})

// [WHAT] 基金名称动态字体大小
const fundNameStyle = computed(() => {
  const name = props.fund.name || '加载中...'
  const len = name.length
  // 根据名称长度动态调整字体大小
  let fontSize = 14
  if (len > 10) fontSize = 13
  if (len > 14) fontSize = 12
  if (len > 18) fontSize = 11
  return { fontSize: `${fontSize}px` }
})

// [WHAT] 均差缓存
const averageDiff = ref<number | null>(null)

// [WHAT] 计算近期均差（从历史净值数据计算）
const calculateAverageDiff = async () => {
  try {
    // 获取最近5天的历史净值
    const history = await fetchNetValueHistoryFast(props.fund.code, 5)
    if (history.length < 2) return
    
    // 计算近期涨跌幅的平均值
    const changes = history.map(h => h.changeRate).filter(c => !isNaN(c))
    if (changes.length === 0) return
    
    const avg = changes.reduce((sum, c) => sum + c, 0) / changes.length
    averageDiff.value = Math.round(avg * 100) / 100
  } catch {
    // 忽略错误
  }
}

// [WHAT] 始终计算均差（用于机构未公布真实涨跌幅时显示）
onMounted(() => {
  calculateAverageDiff()
})

// [WHAT] 实差/均差计算
// 根据机构是否公布今日真实涨跌幅来判断：
// - true（机构已公布）：实差 = 真实涨跌幅 - 估值涨跌幅
// - false（机构未公布）：均差 = 今日估值涨跌幅 - 近期真实涨跌幅的平均值
const diffChange = computed(() => {
  const estimate = props.fund.estimateChange
  const real = props.fund.realChange
  
  // 机构已公布今日真实涨跌幅，计算实差
  if (props.fund.isRealChangeToday) {
    if (estimate === undefined || estimate === null || real === undefined || real === null) {
      return null
    }
    return Number(real) - Number(estimate)
  }
  
  // 机构未公布，计算均差 = 今日估值 - 近期真实涨跌幅的平均值
  if (averageDiff.value !== null && estimate !== undefined && estimate !== null) {
    return Number(estimate) - averageDiff.value
  }
  
  return null
})

// [WHAT] 实差/均差显示文本
const displayDiff = computed(() => {
  if (diffChange.value === null) return null
  const val = diffChange.value
  const sign = val > 0 ? '+' : ''
  return `${sign}${val.toFixed(2)}%`
})

// [WHAT] 实差/均差标签
// 根据机构是否公布今日真实涨跌幅来判断：
// - true（机构已公布）：显示"实差"
// - false（机构未公布）：显示"均差"
const diffLabel = computed(() => {
  return props.fund.isRealChangeToday ? '实差' : '均差'
})

// [WHAT] 实差 CSS 类名
const diffClass = computed(() => {
  if (diffChange.value === null) return ''
  if (diffChange.value > 0) return 'diff-up'
  if (diffChange.value < 0) return 'diff-down'
  return 'diff-flat'
})

// [WHAT] 真实涨跌幅显示
const displayRealChange = computed(() => {
  if (props.fund.realChange === undefined || props.fund.realChange === null) return null
  return formatPercent(props.fund.realChange)
})

// [WHAT] 真实涨跌幅标签
// 根据机构是否公布今日真实涨跌幅来判断：
// - true（机构已公布）：显示"真实"
// - false（机构未公布）：显示"昨"
const realChangeLabel = computed(() => {
  return props.fund.isRealChangeToday ? '真实' : '昨'
})

const realChangeClass = computed(() => {
  if (props.fund.realChange === undefined || props.fund.realChange === null) return ''
  return getChangeStatus(props.fund.realChange)
})

// ========== 数据源相关（新增） ==========

/** 当前数据源名称 */
const dataSourceName = computed(() => {
  const source = props.fund.dataSource || 'fundgz'
  return DATA_SOURCE_CONFIG[source]?.name || '天天基金'
})

/** 最佳数据源标记（从 localStorage 读取） */
const bestSourceLabel = computed((): 'today' | 'yesterday' | null => {
  try {
    const data = localStorage.getItem(`best_source_${props.fund.code}`)
    if (!data) return null
    const parsed = JSON.parse(data)
    const recordDate = parsed.date || ''
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    
    if (recordDate === today) return 'today'
    if (recordDate === yesterday) return 'yesterday'
  } catch {
    // ignore
  }
  return null
})

/** 数据源标签完整文本 */
const dataSourceLabelText = computed(() => {
  const name = dataSourceName.value
  if (bestSourceLabel.value === 'today') return `${name} ★`
  if (bestSourceLabel.value === 'yesterday') return `${name} ☆`
  return name
})

/** 点击数据源标签触发选择器 */
function onSourceSelectClick(event: Event) {
  event.stopPropagation() // 阻止冒泡，避免触发卡片点击
  emit('sourceSelect', props.fund.code)
}

/** 是否有数据源对比数据 */
const hasSourceComparison = computed(() => {
  return props.fund.sourceComparison && Object.keys(props.fund.sourceComparison).length > 0
})
</script>

<template>
  <van-swipe-cell>
    <!-- 基金卡片主体 -->
    <div
      class="fund-card"
      :class="{ loading: fund.loading }"
      @click="emit('click', fund.code)"
      @touchstart="onTouchStart"
      @touchend="onTouchEnd"
      @touchmove="onTouchMove"
    >
      <!-- 左侧：基金信息 -->
      <div class="fund-info">
        <div class="fund-name" :style="fundNameStyle">{{ fund.name || '加载中...' }}</div>
        <div class="fund-meta">
          <a class="fund-code" :href="jdFundLink" @click.stop>{{ fund.code }}</a>
          <span v-if="fund.type" class="fund-type"> · {{ fund.type }}</span>
          <span :class="['fund-tag', statusTagClass]">{{ statusTag }}</span>
        </div>
                                <!-- 估值、真实涨跌幅、实差/均差 -->
        <div class="fund-diff-info" v-if="displayRealChange">
          <span class="diff-label">估值</span>
          <span :class="['diff-value', changeClass]">{{ displayChange }}</span>
          <span class="diff-separator">|</span>
          <span class="diff-label">{{ realChangeLabel }}</span>
          <span :class="['diff-value', realChangeClass]">{{ displayRealChange }}</span>
          <span class="diff-separator">|</span>
          <span class="diff-label">{{ diffLabel }}</span>
          <span :class="['diff-value', diffClass]">{{ displayDiff }}</span>
        </div>
      </div>

                        <!-- 右侧：净值信息（带闪烁效果，盘后切换为真实数据） -->
      <div class="fund-value" :class="[mainChangeClass, flashClass]">
        <div class="estimate-value">{{ displayNetValue }}</div>
        <div class="estimate-change">{{ displayMainChange }}</div>
      </div>
    </div>

    <!-- 右滑：删除按钮 -->
    <template #right>
      <div class="delete-btn" @click.stop="emit('delete', fund.code)">
        删除
      </div>
    </template>
  </van-swipe-cell>
</template>

<style scoped>
.fund-card {
  display: flex;
  align-items: flex-start;
  padding: 12px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  transition: background-color 0.3s;
}

.fund-card.loading {
  opacity: 0.6;
}

.fund-main {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.fund-info {
  flex: 1;
  min-width: 0;
  margin-right: 12px;
}

.fund-name {
  color: var(--text-primary);
  margin-bottom: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fund-meta {
  font-size: 11px;
  color: var(--text-secondary);
}

.fund-code {
  font-size: 11px;
  color: var(--text-secondary);
  text-decoration: none;
}

.fund-type {
  font-size: 11px;
  color: var(--text-secondary);
}

.fund-tag {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  margin-left: 4px;
}

.tag-trading {
  background: rgba(255, 125, 0, 0.1);
  color: #ff7d00;
}

.tag-updated {
  background: rgba(255, 152, 0, 0.15);
  color: #ff9800;
}

/* 数据源切换标签（新增） */
.data-source-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  margin-left: 4px;
  background: rgba(25, 137, 250, 0.12);
  color: #1989fa;
  cursor: pointer;
  user-select: none;
  transition: all 0.2s;
}

.data-source-tag.is-best {
  background: linear-gradient(135deg, rgba(255, 152, 0, 0.15), rgba(76, 175, 80, 0.15));
  color: #ff9800;
}

.data-source-tag:active {
  background: rgba(25, 137, 250, 0.25);
}

.fund-value {
  text-align: right;
  flex-shrink: 0;
  margin-left: 12px;
}

.estimate-value {
  font-size: 18px;
  font-weight: 700;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
  margin-bottom: 2px;
}

.estimate-change {
  font-size: 13px;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
}

/* 涨跌颜色 */
.up .estimate-value,
.up .estimate-change {
  color: var(--color-up);
}

.down .estimate-value,
.down .estimate-change {
  color: var(--color-down);
}

.flat .estimate-value,
.flat .estimate-change {
  color: var(--text-secondary);
}

/* 估值、真实涨跌幅、实差信息 */
.fund-diff-info {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 11px;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
}

.diff-label {
  color: var(--text-secondary);
  font-size: 10px;
}

.diff-value {
  font-weight: 500;
}

.diff-separator {
  color: var(--border-color);
  margin: 0 2px;
}

/* 实差颜色 */
.diff-up {
  color: var(--color-up) !important;
}

.diff-down {
  color: var(--color-down) !important;
}

.diff-flat {
  color: var(--text-secondary) !important;
}

/* 价格闪烁效果 */
.flash-up {
  animation: flashUp 0.5s ease-out;
}

.flash-down {
  animation: flashDown 0.5s ease-out;
}

@keyframes flashUp {
  0% { background-color: rgba(232, 61, 54, 0.2); }
  100% { background-color: transparent; }
}

@keyframes flashDown {
  0% { background-color: rgba(0, 184, 100, 0.2); }
  100% { background-color: transparent; }
}

/* 删除按钮 */
.delete-btn {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 70px;
  background: #ff4d4f;
  color: white;
  font-size: 14px;
}

</style>
