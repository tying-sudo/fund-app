<script setup lang="ts">
// [WHY] 实时分时图组件，模仿股票软件的流畅走势效果
// [WHAT] 1日模式显示涨跌幅百分比走势，其他周期显示历史净值
// [HOW] 使用Canvas绘制，requestAnimationFrame实现流畅动画

import { ref, onMounted, onUnmounted, watch, computed, nextTick } from 'vue'
import { fetchSimpleKLineData, calculatePeriodReturns, clearFundCache, type SimpleKLineData, type PeriodReturn } from '@/api/fundFast'
import { formatPercent, getChangeStatus } from '@/utils/format'

const props = defineProps<{
  fundCode: string
  loading?: boolean
  // [WHAT] 实时估值，用于分时图实时更新
  realtimeValue?: number
  realtimeChange?: number
  // [WHAT] 昨日收盘价，用于计算分时涨跌
  lastClose?: number
}>()

// ========== 数据状态 ==========
const chartData = ref<SimpleKLineData[]>([])
const periodReturns = ref<PeriodReturn[]>([])
const isLoading = ref(false)
const activePeriod = ref('1d') // 默认显示1日分时
const canvasRef = ref<HTMLCanvasElement | null>(null)

// [WHAT] 分时数据（当日实时走势）
interface IntradayPoint {
  time: string  // HH:MM:SS
  value: number
  timestamp: number
}
const intradayData = ref<IntradayPoint[]>([])
const baseValue = ref(0) // 昨收/开盘价作为基准

const periods = [
  { key: '1d', label: '1日', days: 0 },  // 分时图
  { key: '1w', label: '1周', days: 7 },
  { key: '1m', label: '1月', days: 30 },
  { key: '3m', label: '3月', days: 90 },
  { key: '6m', label: '6月', days: 180 },
  { key: '1y', label: '1年', days: 365 },
]

// [WHAT] 判断是否是分时模式
const isIntradayMode = computed(() => activePeriod.value === '1d')

// [WHAT] 根据周期过滤数据
const filteredData = computed(() => {
  // 分时模式返回分时数据
  if (isIntradayMode.value) {
    return intradayData.value.map(p => ({
      time: p.time,
      value: p.value,
      change: baseValue.value > 0 ? ((p.value - baseValue.value) / baseValue.value) * 100 : 0
    }))
  }
  
  const period = periods.find(p => p.key === activePeriod.value)
  if (!period) return chartData.value
  
  const now = new Date()
  const startDate = new Date(now.getTime() - period.days * 24 * 60 * 60 * 1000)
  
  let data = chartData.value.filter(item => new Date(item.time) >= startDate)
  
  // [WHY] 非分时模式下，添加当日数据点
  if (props.realtimeValue && props.realtimeValue > 0) {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const lastIndex = data.length - 1
    
    if (lastIndex >= 0 && data[lastIndex]!.time === today) {
      data = [...data.slice(0, lastIndex), {
        time: today,
        value: props.realtimeValue,
        change: props.realtimeChange || 0
      }]
    } else {
      data = [...data, {
        time: today,
        value: props.realtimeValue,
        change: props.realtimeChange || 0
      }]
    }
  }
  
  return data
})

// [WHAT] 计算区间涨跌幅
const periodChange = computed(() => {
  if (isIntradayMode.value) {
    // 分时模式：相对昨收的涨跌
    if (baseValue.value > 0 && props.realtimeValue) {
      return ((props.realtimeValue - baseValue.value) / baseValue.value) * 100
    }
    return props.realtimeChange || 0
  }
  
  if (filteredData.value.length < 2) return 0
  const first = filteredData.value[0]!.value
  const last = filteredData.value[filteredData.value.length - 1]!.value
  return ((last - first) / first) * 100
})

// [WHAT] 统计数据
const stats = computed(() => {
  const data = filteredData.value
  if (data.length === 0) return { high: 0, low: 0, count: 0 }
  const values = data.map(d => d.value)
  return {
    high: Math.max(...values),
    low: Math.min(...values),
    count: data.length
  }
})

// ========== 分时数据管理 ==========

// [WHAT] 添加分时数据点
function addIntradayPoint(value: number) {
  if (!value || value <= 0) return
  
  const now = new Date()
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
  
  // [WHAT] 设置基准值（第一个点或昨收）
  if (baseValue.value === 0) {
    baseValue.value = props.lastClose || value
  }
  
  // [WHY] 限制数据点数量，保持流畅性（最多保留600个点，约10分钟秒级数据）
  const maxPoints = 600
  if (intradayData.value.length >= maxPoints) {
    intradayData.value = intradayData.value.slice(-maxPoints + 1)
  }
  
  intradayData.value.push({
    time: timeStr,
    value,
    timestamp: now.getTime()
  })
}

// [WHAT] 重置分时数据（新的一天）
function resetIntradayData() {
  intradayData.value = []
  baseValue.value = props.lastClose || 0
}

// ========== 数据加载 ==========
async function loadData() {
  if (!props.fundCode) return
  
  isLoading.value = true
  try {
    // [WHY] 清除缓存确保获取最新数据
    clearFundCache(props.fundCode)
    
    // 并发加载K线数据和阶段涨幅
    const [kline, returns] = await Promise.all([
      fetchSimpleKLineData(props.fundCode, 400),
      calculatePeriodReturns(props.fundCode)
    ])
    
    chartData.value = kline
    periodReturns.value = returns
    
    await nextTick()
    drawChart()
  } catch (err) {
    console.error('加载图表数据失败:', err)
  } finally {
    isLoading.value = false
  }
}

// ========== Canvas绘图 ==========
function drawChart() {
  const canvas = canvasRef.value
  if (!canvas) {
    setTimeout(drawChart, 50)
    return
  }
  
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  
  const data = filteredData.value
  if (data.length === 0) return
  
  // 设置Canvas尺寸（高清屏适配）
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  
  if (rect.width === 0 || rect.height === 0) {
    setTimeout(drawChart, 50)
    return
  }
  
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)
  
  const width = rect.width
  const height = rect.height
  const padding = { top: 20, right: 10, bottom: 30, left: 50 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  
  // 清除画布
  ctx.clearRect(0, 0, width, height)
  
  // [WHAT] 分时模式下，Y轴显示涨跌幅百分比
  if (isIntradayMode.value) {
    drawIntradayPercentageChart(ctx, data, width, height, padding, chartWidth, chartHeight)
  } else {
    drawNetValueChart(ctx, data, width, height, padding, chartWidth, chartHeight)
  }
}

// [WHAT] 分时模式：绘制涨跌幅百分比走势图
function drawIntradayPercentageChart(
  ctx: CanvasRenderingContext2D,
  data: { time: string; value: number; change?: number }[],
  width: number,
  height: number,
  padding: { top: number; right: number; bottom: number; left: number },
  chartWidth: number,
  chartHeight: number
) {
  // 计算涨跌幅百分比
  const changes = data.map(d => {
    if (d.change !== undefined) return d.change
    if (baseValue.value > 0) return ((d.value - baseValue.value) / baseValue.value) * 100
    return 0
  })
  
  let minChange = Math.min(...changes)
  let maxChange = Math.max(...changes)
  
  // [WHY] 确保0%在可视范围内，并留出余量
  const margin = Math.abs(maxChange - minChange) * 0.2 || 0.5
  minChange = Math.min(minChange, 0) - margin
  maxChange = Math.max(maxChange, 0) + margin
  
  const changeRange = maxChange - minChange || 1
  
  // 绘制背景网格
  ctx.strokeStyle = '#f0f0f0'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartHeight / 4) * i
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(width - padding.right, y)
    ctx.stroke()
  }
  
  // 绘制0%基准线
  const zeroY = padding.top + chartHeight - ((0 - minChange) / changeRange) * chartHeight
  ctx.beginPath()
  ctx.setLineDash([4, 4])
  ctx.strokeStyle = '#999'
  ctx.lineWidth = 1
  ctx.moveTo(padding.left, zeroY)
  ctx.lineTo(width - padding.right, zeroY)
  ctx.stroke()
  ctx.setLineDash([])
  
  // 标注0%
  ctx.fillStyle = '#999'
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('0%', width - padding.right + 2, zeroY + 3)
  
  // 绘制Y轴刻度（百分比）
  ctx.fillStyle = '#999'
  ctx.font = '11px sans-serif'
  ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i++) {
    const change = maxChange - (changeRange / 4) * i
    const y = padding.top + (chartHeight / 4) * i
    ctx.fillText(change.toFixed(2) + '%', padding.left - 5, y + 4)
  }
  
  // 判断涨跌
  const lastChange = changes[changes.length - 1] || 0
  const isUp = lastChange >= 0
  const lineColor = isUp ? '#e4393c' : '#1db82c'
  const fillColor = isUp ? 'rgba(228, 57, 60, 0.15)' : 'rgba(29, 184, 44, 0.15)'
  
  // 绘制填充区域（从0%线开始）
  ctx.beginPath()
  ctx.moveTo(padding.left, zeroY)
  
  data.forEach((point, i) => {
    const x = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * i
    const change = changes[i]!
    const y = padding.top + chartHeight - ((change - minChange) / changeRange) * chartHeight
    ctx.lineTo(x, y)
  })
  
  // 连接回0%线
  const lastX = padding.left + chartWidth
  ctx.lineTo(lastX, zeroY)
  ctx.closePath()
  ctx.fillStyle = fillColor
  ctx.fill()
  
  // 绘制线条
  ctx.beginPath()
  data.forEach((point, i) => {
    const x = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * i
    const change = changes[i]!
    const y = padding.top + chartHeight - ((change - minChange) / changeRange) * chartHeight
    if (i === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  })
  ctx.strokeStyle = lineColor
  ctx.lineWidth = 2
  ctx.stroke()
  
  // 绘制最新点的脉冲效果
  if (data.length > 0) {
    const lastPointX = padding.left + chartWidth
    const lastChangeValue = changes[changes.length - 1]!
    const lastPointY = padding.top + chartHeight - ((lastChangeValue - minChange) / changeRange) * chartHeight
    
    // 脉冲圆圈
    const pulseRadius = 4 + Math.sin(Date.now() / 200) * 2
    ctx.beginPath()
    ctx.arc(lastPointX, lastPointY, pulseRadius, 0, Math.PI * 2)
    ctx.fillStyle = lineColor
    ctx.fill()
    
    // 外圈光晕
    ctx.beginPath()
    ctx.arc(lastPointX, lastPointY, pulseRadius + 4, 0, Math.PI * 2)
    ctx.strokeStyle = lineColor
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.3
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  
  // 绘制X轴标签
  ctx.fillStyle = '#999'
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'center'
  
  const labelCount = Math.min(5, data.length)
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.floor((data.length - 1) * i / Math.max(labelCount - 1, 1))
    const point = data[idx]
    if (!point) continue
    const x = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * idx
    ctx.fillText(point.time.slice(0, 5), x, height - 10)
  }
}

// [WHAT] 非分时模式：绘制净值走势图
function drawNetValueChart(
  ctx: CanvasRenderingContext2D,
  data: { time: string; value: number; change?: number }[],
  width: number,
  height: number,
  padding: { top: number; right: number; bottom: number; left: number },
  chartWidth: number,
  chartHeight: number
) {
  // 计算数据范围
  const values = data.map(d => d.value)
  let minValue = Math.min(...values)
  let maxValue = Math.max(...values)
  
  const valueRange = maxValue - minValue || 1
  
  // 绘制背景网格
  ctx.strokeStyle = '#f0f0f0'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartHeight / 4) * i
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(width - padding.right, y)
    ctx.stroke()
  }
  
  // 绘制Y轴刻度
  ctx.fillStyle = '#999'
  ctx.font = '11px sans-serif'
  ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i++) {
    const value = maxValue - (valueRange / 4) * i
    const y = padding.top + (chartHeight / 4) * i
    ctx.fillText(value.toFixed(4), padding.left - 5, y + 4)
  }
  
  // 判断涨跌
  const isUp = periodChange.value >= 0
  const lineColor = isUp ? '#e4393c' : '#1db82c'
  const fillColor = isUp ? 'rgba(228, 57, 60, 0.15)' : 'rgba(29, 184, 44, 0.15)'
  
  // 绘制填充区域
  ctx.beginPath()
  ctx.moveTo(padding.left, padding.top + chartHeight)
  
  data.forEach((point, i) => {
    const x = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * i
    const y = padding.top + chartHeight - ((point.value - minValue) / valueRange) * chartHeight
    ctx.lineTo(x, y)
  })
  
  // 连接回底部
  const lastX = padding.left + chartWidth
  ctx.lineTo(lastX, padding.top + chartHeight)
  ctx.closePath()
  ctx.fillStyle = fillColor
  ctx.fill()
  
  // 绘制线条
  ctx.beginPath()
  data.forEach((point, i) => {
    const x = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * i
    const y = padding.top + chartHeight - ((point.value - minValue) / valueRange) * chartHeight
    if (i === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  })
  ctx.strokeStyle = lineColor
  ctx.lineWidth = 2
  ctx.stroke()
  
  // 绘制X轴标签
  ctx.fillStyle = '#999'
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'center'
  
  const labelCount = Math.min(5, data.length)
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.floor((data.length - 1) * i / Math.max(labelCount - 1, 1))
    const point = data[idx]
    if (!point) continue
    const x = padding.left + (chartWidth / Math.max(data.length - 1, 1)) * idx
    ctx.fillText(point.time.slice(5), x, height - 10)
  }
}

// ========== 事件处理 ==========
function selectPeriod(key: string) {
  activePeriod.value = key
  // [WHAT] 切换到分时模式时重置数据并启动动画
  if (key === '1d') {
    resetIntradayData()
    if (props.realtimeValue) {
      addIntradayPoint(props.realtimeValue)
    }
    nextTick(() => {
      drawChart()
      startPulseAnimation()
    })
  } else {
    stopPulseAnimation()
    nextTick(drawChart)
  }
}

// ========== 动画相关 ==========
let animationFrame: number | null = null
let pulseAnimationFrame: number | null = null
let lastDrawTime = 0
const MIN_DRAW_INTERVAL = 16 // 约60fps

// [WHAT] 节流绘制，避免过度重绘
function throttledDraw() {
  const now = performance.now()
  if (now - lastDrawTime < MIN_DRAW_INTERVAL) {
    if (animationFrame) cancelAnimationFrame(animationFrame)
    animationFrame = requestAnimationFrame(throttledDraw)
    return
  }
  lastDrawTime = now
  drawChart()
}

// [WHAT] 分时模式下的脉冲动画循环
function startPulseAnimation() {
  if (pulseAnimationFrame) return
  
  let lastTime = 0
  function throttledAnimate(time: number) {
    if (!isIntradayMode.value) {
      pulseAnimationFrame = null
      return
    }
    
    if (time - lastTime > 33) { // 约30fps
      lastTime = time
      drawChart()
    }
    pulseAnimationFrame = requestAnimationFrame(throttledAnimate)
  }
  
  pulseAnimationFrame = requestAnimationFrame(throttledAnimate)
}

function stopPulseAnimation() {
  if (pulseAnimationFrame) {
    cancelAnimationFrame(pulseAnimationFrame)
    pulseAnimationFrame = null
  }
}

// ========== 生命周期 ==========
watch(() => props.fundCode, () => {
  resetIntradayData()
  loadData()
}, { immediate: true })

// [WHY] 监听实时数据变化，分时模式下累积数据点
watch(() => props.realtimeValue, (newVal) => {
  if (newVal && newVal > 0) {
    // [WHAT] 分时模式：添加新数据点，图表流畅走动
    if (isIntradayMode.value) {
      addIntradayPoint(newVal)
    }
    // [WHAT] 使用节流绘制实现流畅动画
    throttledDraw()
  }
})

// [WHAT] 监听lastClose变化，更新基准值
watch(() => props.lastClose, (newVal) => {
  if (newVal && newVal > 0 && baseValue.value === 0) {
    baseValue.value = newVal
  }
})

// 窗口resize时重绘
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  if (canvasRef.value) {
    resizeObserver = new ResizeObserver(() => {
      drawChart()
    })
    resizeObserver.observe(canvasRef.value.parentElement!)
  }
  
  // [WHAT] 初始化分时数据
  if (props.realtimeValue) {
    addIntradayPoint(props.realtimeValue)
  }
  
  // [WHAT] 默认分时模式，启动脉冲动画
  if (isIntradayMode.value) {
    setTimeout(startPulseAnimation, 500)
  }
})

onUnmounted(() => {
  stopPulseAnimation()
  resizeObserver?.disconnect()
  if (animationFrame) cancelAnimationFrame(animationFrame)
})
</script>

<template>
  <div class="simple-chart">
    <!-- 时间周期选择 -->
    <div class="period-tabs">
      <div
        v-for="p in periods"
        :key="p.key"
        class="period-tab"
        :class="{ active: activePeriod === p.key }"
        @click="selectPeriod(p.key)"
      >
        {{ p.label }}
      </div>
    </div>
    
    <!-- 区间涨跌 -->
    <div class="period-info">
      <span class="info-label">{{ periods.find(p => p.key === activePeriod)?.label }}涨跌</span>
      <span class="info-value" :class="getChangeStatus(periodChange)">
        {{ formatPercent(periodChange) }}
      </span>
    </div>
    
    <!-- 图表区域 -->
    <div class="chart-wrapper">
      <div v-if="isLoading || loading" class="chart-loading">
        <van-loading size="24px">加载中...</van-loading>
      </div>
      <div v-else-if="filteredData.length === 0" class="chart-empty">
        暂无数据
      </div>
      <canvas v-else ref="canvasRef" class="chart-canvas"></canvas>
    </div>
    
    <!-- 统计数据 -->
    <div v-if="filteredData.length > 0" class="chart-stats">
      <div class="stat-item">
        <span class="stat-label">{{ isIntradayMode ? '昨收' : '最高' }}</span>
        <span class="stat-value">{{ isIntradayMode ? (baseValue || lastClose || 0).toFixed(4) : stats.high.toFixed(4) }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">{{ isIntradayMode ? '最高' : '最低' }}</span>
        <span class="stat-value" :class="isIntradayMode ? 'up' : ''">
          {{ isIntradayMode ? stats.high.toFixed(4) : stats.low.toFixed(4) }}
        </span>
      </div>
      <div class="stat-item">
        <span class="stat-label">{{ isIntradayMode ? '最低' : '当前' }}</span>
        <span class="stat-value" :class="isIntradayMode ? 'down' : getChangeStatus(realtimeChange || 0)">
          {{ isIntradayMode ? stats.low.toFixed(4) : (realtimeValue ? realtimeValue.toFixed(4) : '--') }}
        </span>
      </div>
      <div v-if="isIntradayMode" class="stat-item">
        <span class="stat-label">当前</span>
        <span class="stat-value realtime" :class="getChangeStatus(realtimeChange || 0)">
          {{ realtimeValue ? realtimeValue.toFixed(4) : '--' }}
        </span>
      </div>
    </div>
    
    <!-- 阶段涨幅（模仿交易所） -->
    <div v-if="periodReturns.length > 0" class="returns-grid">
      <div v-for="r in periodReturns" :key="r.period" class="return-item">
        <span class="return-label">{{ r.label }}</span>
        <span class="return-value" :class="getChangeStatus(r.change)">
          {{ formatPercent(r.change) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.simple-chart {
  background: #fff;
  padding: 16px;
}

/* 时间周期选择 */
.period-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.period-tab {
  padding: 6px 14px;
  font-size: 13px;
  color: #666;
  background: #f5f5f5;
  border-radius: 16px;
  cursor: pointer;
  transition: all 0.2s;
}

.period-tab.active {
  color: #1989fa;
  background: rgba(25, 137, 250, 0.1);
  font-weight: 500;
}

/* 区间涨跌 */
.period-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.info-label {
  font-size: 14px;
  color: #666;
}

.info-value {
  font-size: 20px;
  font-weight: 600;
  font-family: 'DIN Alternate', monospace;
}

.info-value.up { color: #e4393c; }
.info-value.down { color: #1db82c; }
.info-value.flat { color: #999; }

/* 图表区域 */
.chart-wrapper {
  position: relative;
  height: 200px;
  margin-bottom: 12px;
}

.chart-canvas {
  width: 100%;
  height: 100%;
}

.chart-loading,
.chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #999;
}

/* 统计数据 */
.chart-stats {
  display: flex;
  justify-content: space-around;
  padding: 12px 0;
  border-top: 1px solid #f0f0f0;
  border-bottom: 1px solid #f0f0f0;
}

.stat-item {
  text-align: center;
}

.stat-label {
  display: block;
  font-size: 12px;
  color: #999;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 14px;
  color: #333;
  font-weight: 500;
}

.stat-value.up { color: #e4393c; }
.stat-value.down { color: #1db82c; }

/* 实时数据高亮 */
.stat-value.realtime {
  font-family: 'DIN Alternate', monospace;
  animation: realtime-pulse 2s infinite;
}

.stat-value.realtime.up { color: #e4393c; }
.stat-value.realtime.down { color: #1db82c; }

@keyframes realtime-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

/* 阶段涨幅网格 */
.returns-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  margin-top: 12px;
}

.return-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 4px;
  background: #f8f8f8;
  border-radius: 8px;
}

.return-label {
  font-size: 11px;
  color: #999;
  margin-bottom: 4px;
}

.return-value {
  font-size: 14px;
  font-weight: 600;
  font-family: 'DIN Alternate', monospace;
}

.return-value.up { color: #e4393c; }
.return-value.down { color: #1db82c; }
.return-value.flat { color: #999; }
</style>
