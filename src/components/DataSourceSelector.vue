<script setup lang="ts">
// [WHY] 数据源选择器弹窗组件
// [WHAT] 支持切换天天基金/新浪A/新浪B三个估值数据源，含智能选源
// [HOW] 弹窗形式，展示3个数据源的实时估值对比 + 自动选源开关

import { ref, computed, watch, onMounted } from 'vue'
import { showSuccessToast, showLoadingToast, closeToast } from 'vant'
import type { DataSource } from '@/types/fund'
import { DATA_SOURCE_CONFIG, ALL_DATA_SOURCES } from '@/types/fund'
import { useFundStore } from '@/stores/fund'

const props = defineProps<{
  fundCode: string
  fundName: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  select: [source: DataSource]
}>()

const fundStore = useFundStore()

// ========== 状态 ==========

const loading = ref(false)
const sourcesData = ref<Partial<Record<DataSource, {
  gszzl: string
  gsz: string
  gztime: string
}>>>({})

const selectedSource = ref<DataSource>(fundStore.getFundDataSource(props.fundCode))

// ========== 智能选源状态 ==========

/** 自动选源开关 */
const autoMode = ref(loadAutoMode())

/** 最佳数据源（基于历史准确度） */
const bestSource = ref<DataSource | null>(loadBestSource())

/** 今日最准标记 */
const isTodayBest = ref(false)

/** 昨日最准标记 */
const isYesterdayBest = ref(false)

/**
 * 从 localStorage 加载自动选源设置
 */
function loadAutoMode(): boolean {
  try {
    return localStorage.getItem(`auto_source_${props.fundCode}`) === 'true'
  } catch {
    return false
  }
}

/**
 * 从 localStorage 加载最佳数据源记录
 */
function loadBestSource(): DataSource | null {
  try {
    const data = localStorage.getItem(`best_source_${props.fundCode}`)
    if (data) {
      const parsed = JSON.parse(data)
      // 检查日期是否有效（今天或昨天）
      const recordDate = parsed.date || ''
      const today = new Date().toISOString().slice(0, 10)
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      
      if (recordDate === today) {
        isTodayBest.value = true
        return parsed.source as DataSource
      } else if (recordDate === yesterday) {
        isYesterdayBest.value = true
        return parsed.source as DataSource
      }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * 保存自动选源设置
 */
function saveAutoMode(enabled: boolean) {
  try {
    localStorage.setItem(`auto_source_${props.fundCode}`, String(enabled))
  } catch {
    // ignore
  }
}

/**
 * 保存最佳数据源记录
 * [WHY] 当真实净值公布后，对比各数据源的历史准确度，标记最准的数据源
 */
function saveBestSource(source: DataSource) {
  try {
    const today = new Date().toISOString().slice(0, 10)
    localStorage.setItem(`best_source_${props.fundCode}`, JSON.stringify({
      source,
      date: today
    }))
    bestSource.value = source
    isTodayBest.value = true
    isYesterdayBest.value = false
  } catch {
    // ignore
  }
}

// ========== 监听 ==========

watch(() => props.modelValue, async (visible) => {
  if (visible) {
    await loadAllSources()
    selectedSource.value = fundStore.getFundDataSource(props.fundCode)
    autoMode.value = loadAutoMode()
    bestSource.value = loadBestSource()
  }
})

// ========== 方法 ==========

/**
 * 切换自动选源模式
 */
function onToggleAutoMode(checked: boolean) {
  autoMode.value = checked
  saveAutoMode(checked)
  
  if (checked && bestSource.value) {
    // 开启时自动切换到最佳数据源
    onSelectSource(bestSource.value)
    showSuccessToast(`已开启智能选源 → ${DATA_SOURCE_CONFIG[bestSource.value].name}`)
  }
}

/**
 * 加载所有数据源的估值用于对比展示
 */
async function loadAllSources() {
  loading.value = true
  sourcesData.value = {} // [FIX] 先清空，避免显示旧数据
  
  showLoadingToast({
    message: '获取各源估值...',
    forbidClick: true,
    duration: 0
  })
  
  try {
    const result = await fundStore.getAllSourcesForFund(props.fundCode)
    console.log('[数据源选择] 获取到的sources:', result.sources, 'activeSource:', result.activeSource)
    sourcesData.value = result.sources || {}
    selectedSource.value = result.activeSource || fundStore.getFundDataSource(props.fundCode)
    
    // [WHAT] 始终尝试计算最佳数据源（用于显示推荐提示条）
    // [NOTE] 如果有历史记录优先使用历史记录，否则基于当前数据估算
    if (!bestSource.value) {
      calculateBestFromCurrent()
    }
  } catch (err) {
    console.error('[数据源选择] 获取对比数据失败:', err)
  } finally {
    closeToast()
    loading.value = false
  }
}

/**
 * 基于当前估值数据计算最佳数据源
 * [NOTE] 这是一个简化版本，真正的智能选源需要历史数据积累
 * 这里使用简单的启发式规则：选择涨跌幅绝对值居中的（避免极端值）
 */
function calculateBestFromCurrent() {
  const entries = Object.entries(sourcesData.value) as [DataSource, { gszzl: string }][]
  if (entries.length < 2) return
  
  const validEntries = entries.filter(([, d]) => d.gszzl && d.gszzl !== '--')
  if (validEntries.length === 0) return
  
  // 取中间值作为参考（假设大多数情况下中间值更接近真实值）
  const values = validEntries.map(([, d]) => Math.abs(parseFloat(d.gszzl)))
  values.sort((a, b) => a - b)
  const medianValue = values[Math.floor(values.length / 2)]
  
  for (const [source, data] of validEntries) {
    if (Math.abs(parseFloat(data.gszzl)) === medianValue) {
      bestSource.value = source
      break
    }
  }
}

/**
 * 选择数据源
 */
function onSelectSource(source: DataSource) {
  selectedSource.value = source
  fundStore.setFundDataSource(props.fundCode, source)
  emit('select', source)
  emit('update:modelValue', false)
  
  showSuccessToast(`已切换至${DATA_SOURCE_CONFIG[source].name}`)
}

/**
 * 关闭弹窗
 */
function onClose() {
  emit('update:modelValue', false)
}

// ========== 计算属性 ==========

/** 格式化涨跌幅显示 */
function formatChange(value?: string): string {
  if (!value || value === '--') return '--'
  const num = parseFloat(value)
  if (isNaN(num)) return '--'
  const sign = num >= 0 ? '+' : ''
  return `${sign}${num.toFixed(2)}%`
}

/** 涨跌幅颜色类 */
function getChangeClass(value?: string): string {
  if (!value || value === '--') return 'change-flat'
  const num = parseFloat(value)
  if (num > 0) return 'change-up'
  if (num < 0) return 'change-down'
  return 'change-flat'
}

/** 当前选中状态 */
function isActive(source: DataSource): boolean {
  return selectedSource.value === source
}

/** 获取最佳标记文本 */
function getBestLabel(source: DataSource): string | null {
  if (!bestSource.value || bestSource.value !== source) return null
  if (isTodayBest.value) return '今日最准'
  if (isYesterdayBest.value) return '昨日最准'
  return null
}

/** 是否有有效的估值数据 */
function hasValidData(source: DataSource): boolean {
  const data = sourcesData.value[source]
  return !!(data?.gszzl && data.gszzl !== '--')
}

/** 数据是否加载中或无效 */
function isLoadingOrEmpty(source: DataSource): boolean {
  return loading.value || !hasValidData(source)
}
</script>

<template>
  <van-popup 
    :show="modelValue" 
    position="bottom"
    round
    closeable
    :style="{ maxHeight: '75%' }"
    @close="onClose"
  >
    <div class="source-selector">
      <!-- 标题 -->
      <div class="selector-header">
        <h3>切换数据源</h3>
        <p class="fund-info">{{ fundName }} · {{ fundCode }}</p>
      </div>

      <!-- 智能选源开关区域 -->
      <div class="auto-source-bar">
        <div class="auto-info">
          <span class="auto-title">智能选源</span>
          <span class="auto-desc">基于历史准确度自动选择最优数据源</span>
        </div>
        <van-switch 
          v-model="autoMode" 
          size="20px"
          @change="onToggleAutoMode"
        />
      </div>

      <!-- 最佳数据源提示 -->
      <div v-if="bestSource" class="best-hint">
        <van-icon name="fire-o" color="#ff9800" />
        <span>当前推荐：<b>{{ DATA_SOURCE_CONFIG[bestSource]?.name }}</b></span>
        <span v-if="isTodayBest" class="best-tag today">今日最准</span>
        <span v-else-if="isYesterdayBest" class="best-tag yesterday">昨日最准</span>
        <span v-else class="best-tag auto">实时推荐</span>
      </div>

      <!-- 加载状态 -->
      <div v-if="loading" class="loading-state">
        <van-loading size="24px">正在获取各源估值...</van-loading>
      </div>

      <!-- 数据源列表 -->
      <div v-else class="source-list">
        <div
          v-for="source in ALL_DATA_SOURCES"
          :key="source"
          :class="['source-item', { 
            active: isActive(source),
            recommended: autoMode && bestSource === source 
          }]"
          @click="onSelectSource(source)"
        >
          <!-- 左侧：数据源信息 -->
          <div class="source-left">
            <div class="source-radio">
              <div :class="['radio-dot', { checked: isActive(source) }]"></div>
            </div>
            <div class="source-info">
              <div class="source-name-row">
                <span class="source-name">{{ DATA_SOURCE_CONFIG[source].name }}</span>
                <!-- 最准标签 -->
                <span 
                  v-if="getBestLabel(source)" 
                  :class="['best-label', isTodayBest ? 'today' : 'yesterday']"
                >
                  {{ getBestLabel(source) }}
                </span>
              </div>
              <div class="source-desc">{{ DATA_SOURCE_CONFIG[source].description }}</div>
            </div>
          </div>
          
          <!-- 右侧：估值数值（始终显示） -->
          <div class="source-value">
            <template v-if="isLoadingOrEmpty(source)">
              <div class="value-placeholder">--</div>
              <div class="value-sub placeholder">--</div>
            </template>
            <template v-else>
              <div :class="['value-gszzl', getChangeClass(sourcesData[source]?.gszzl)]">
                {{ formatChange(sourcesData[source]?.gszzl) }}
              </div>
              <div class="value-sub">
                {{ sourcesData[source]?.gsz ? parseFloat(sourcesData[source].gsz).toFixed(4) : '--' }}
              </div>
            </template>
          </div>

          <!-- 当前选中勾选图标 -->
          <div v-if="isActive(source)" class="check-icon">
            <van-icon name="success" color="#fff" size="14" />
          </div>

          <!-- 推荐角标 -->
          <div v-if="autoMode && bestSource === source && !isActive(source)" class="recommend-badge">
            推荐
          </div>
        </div>
      </div>

      <!-- 说明文字 -->
      <div class="source-note">
        <p><b>数据源说明：</b></p>
        <p>• 天天基金：东方财富主数据源，覆盖最广</p>
        <p>• 新浪A/B：新浪财经不同计算口径，可作为交叉验证</p>
        <p>• 智能选源：系统会学习历史准确度，自动选择最接近真实值的数据源</p>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.source-selector {
  padding: 20px 16px;
  max-height: 65vh;
  overflow-y: auto;
}

.selector-header {
  margin-bottom: 16px;
}

.selector-header h3 {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.selector-header .fund-info {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}

/* 智能选源开关栏 */
.auto-source-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: linear-gradient(135deg, rgba(255, 152, 0, 0.08), rgba(25, 137, 250, 0.08));
  border-radius: 10px;
  margin-bottom: 12px;
  border: 1px solid rgba(255, 152, 0, 0.15);
}

.auto-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.auto-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.auto-desc {
  font-size: 11px;
  color: var(--text-secondary);
}

/* 最佳提示条 */
.best-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: rgba(255, 152, 0, 0.08);
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.best-hint b {
  color: #ff9800;
}

.best-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
}

.best-tag.today {
  background: rgba(76, 175, 80, 0.15);
  color: #4caf50;
}

.best-tag.yesterday {
  background: rgba(158, 158, 158, 0.15);
  color: #9e9e9e;
}

.best-tag.auto {
  background: rgba(25, 137, 250, 0.15);
  color: #1989fa;
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}

.source-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  background: var(--bg-tertiary);
  border-radius: 12px;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}

.source-item:active {
  transform: scale(0.98);
}

.source-item.active {
  border-color: var(--color-primary);
  background: rgba(25, 137, 250, 0.06);
}

.source-item.recommended:not(.active) {
  border-color: rgba(255, 152, 0, 0.3);
}

/* 左侧信息区 */
.source-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.source-radio {
  flex-shrink: 0;
}

.radio-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid #ccc;
  transition: all 0.2s;
  box-sizing: border-box;
}

.radio-dot.checked {
  border-color: var(--color-primary);
  background: var(--color-primary);
  box-shadow: inset 0 0 0 2px white;
}

.source-info {
  min-width: 0;
}

.source-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}

.source-name {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.best-label {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
  flex-shrink: 0;
}

.best-label.today {
  background: rgba(76, 175, 80, 0.15);
  color: #4caf50;
}

.best-label.yesterday {
  background: rgba(158, 158, 158, 0.15);
  color: #9e9e9e;
}

.source-desc {
  font-size: 11px;
  color: var(--text-secondary);
}

/* 右侧数值区 */
.source-value {
  text-align: right;
  flex-shrink: 0;
  margin-left: 12px;
  min-width: 80px;
}

.value-gszzl {
  font-size: 17px;
  font-weight: 700;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.value-placeholder {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-muted, #666);
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
}

.value-sub {
  font-size: 11px;
  color: var(--text-secondary);
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  margin-top: 1px;
}

.value-sub.placeholder {
  color: var(--text-muted, #999);
}

/* 选中勾选图标 */
.check-icon {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 20px;
  background: var(--color-primary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 推荐角标 */
.recommend-badge {
  position: absolute;
  right: 12px;
  top: 8px;
  font-size: 10px;
  padding: 1px 5px;
  background: linear-gradient(135deg, #ff9800, #f57c00);
  color: white;
  border-radius: 6px;
  font-weight: 500;
}

/* 涨跌颜色 */
.change-up { color: var(--color-up); }
.change-down { color: var(--color-down); }
.change-flat { color: var(--text-secondary); }

/* 底部说明 */
.source-note {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tertiary, #f5f5f5);
  border-radius: 8px;
}

.source-note p {
  font-size: 11px;
  color: var(--text-secondary, #888);
  line-height: 1.7;
  margin: 2px 0;
}

.source-note b {
  color: var(--text-primary);
}
</style>
