<script setup lang="ts">
// [WHY] 定投计算器 - 模拟定投收益和复利计算
// [WHAT] 支持设置定投金额、周期、年化收益率，计算最终收益
// [HOW] 使用复利公式计算定投收益，支持图表展示

import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useThemeStore } from '@/stores/theme'

const router = useRouter()
const themeStore = useThemeStore()

// ========== 计算参数 ==========
const monthlyAmount = ref(1000)       // 每月定投金额
const investYears = ref(10)           // 定投年限
const expectedReturn = ref(8)          // 预期年化收益率 (%)
const investFrequency = ref<'monthly' | 'weekly'>('monthly')  // 定投频率

// [WHAT] 预设年化收益率选项
const returnPresets = [
  { label: '保守 (4%)', value: 4 },
  { label: '稳健 (8%)', value: 8 },
  { label: '积极 (12%)', value: 12 },
  { label: '激进 (15%)', value: 15 }
]

// [WHAT] 预设定投年限选项
const yearPresets = [3, 5, 10, 15, 20, 30]

// ========== 计算结果 ==========
interface ResultData {
  totalInvest: number      // 总投入
  totalValue: number       // 最终金额
  totalProfit: number      // 总收益
  profitRate: number       // 收益率
  yearlyData: { year: number; invest: number; value: number }[]  // 每年数据
}

const result = computed<ResultData>(() => {
  const monthly = monthlyAmount.value
  const years = investYears.value
  const annualRate = expectedReturn.value / 100
  
  // [WHAT] 计算定投期数
  const periods = investFrequency.value === 'monthly' ? years * 12 : years * 52
  const periodRate = investFrequency.value === 'monthly' 
    ? annualRate / 12 
    : annualRate / 52
  const periodAmount = investFrequency.value === 'monthly' 
    ? monthly 
    : monthly / 4.33  // 周定投金额约为月定投的1/4.33

  // [WHAT] 定投终值公式
  // FV = P × [(1 + r)^n - 1] / r × (1 + r)
  // P = 每期投入, r = 每期利率, n = 期数
  let totalValue: number
  if (periodRate === 0) {
    totalValue = periodAmount * periods
  } else {
    totalValue = periodAmount * ((Math.pow(1 + periodRate, periods) - 1) / periodRate) * (1 + periodRate)
  }

  const totalInvest = monthly * years * 12
  const totalProfit = totalValue - totalInvest
  const profitRate = totalInvest > 0 ? (totalProfit / totalInvest) * 100 : 0

  // [WHAT] 计算每年末的数据（用于图表）
  const yearlyData: { year: number; invest: number; value: number }[] = []
  for (let y = 1; y <= years; y++) {
    const yPeriods = investFrequency.value === 'monthly' ? y * 12 : y * 52
    let yValue: number
    if (periodRate === 0) {
      yValue = periodAmount * yPeriods
    } else {
      yValue = periodAmount * ((Math.pow(1 + periodRate, yPeriods) - 1) / periodRate) * (1 + periodRate)
    }
    yearlyData.push({
      year: y,
      invest: monthly * y * 12,
      value: yValue
    })
  }

  return { totalInvest, totalValue, totalProfit, profitRate, yearlyData }
})

// ========== 图表绘制 ==========
const canvasRef = ref<HTMLCanvasElement | null>(null)

function getThemeColors() {
  const isDark = themeStore.actualTheme === 'dark'
  return {
    bg: isDark ? '#0b0e11' : '#ffffff',
    text: isDark ? '#848e9c' : '#666666',
    grid: isDark ? '#1e2329' : '#f0f0f0',
    investColor: isDark ? '#848e9c' : '#999999',
    valueColor: '#f7931a',
    profitColor: '#0ecb81'
  }
}

function drawChart() {
  const canvas = canvasRef.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const colors = getThemeColors()
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
  const padding = { top: 20, right: 50, bottom: 40, left: 10 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom

  // 清空
  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, width, height)

  const data = result.value.yearlyData
  if (data.length === 0) return

  const maxValue = Math.max(...data.map(d => d.value))
  const barWidth = Math.min(chartWidth / data.length * 0.7, 30)
  const gap = (chartWidth - barWidth * data.length) / (data.length + 1)

  // [WHAT] 绘制网格线
  ctx.strokeStyle = colors.grid
  ctx.lineWidth = 1
  const ySteps = 4
  for (let i = 0; i <= ySteps; i++) {
    const y = padding.top + (chartHeight / ySteps) * i
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(width - padding.right, y)
    ctx.stroke()
  }

  // [WHAT] 绘制柱状图
  data.forEach((d, i) => {
    const x = padding.left + gap + i * (barWidth + gap)
    
    // 投入部分（底部）
    const investHeight = (d.invest / maxValue) * chartHeight
    const investY = padding.top + chartHeight - investHeight
    ctx.fillStyle = colors.investColor
    ctx.fillRect(x, investY, barWidth, investHeight)
    
    // 收益部分（顶部）
    const profitHeight = ((d.value - d.invest) / maxValue) * chartHeight
    const profitY = investY - profitHeight
    ctx.fillStyle = colors.profitColor
    ctx.fillRect(x, profitY, barWidth, profitHeight)
    
    // X轴标签
    ctx.fillStyle = colors.text
    ctx.font = '10px -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`${d.year}年`, x + barWidth / 2, height - padding.bottom + 15)
  })

  // [WHAT] Y轴标签
  ctx.fillStyle = colors.text
  ctx.font = '10px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  for (let i = 0; i <= ySteps; i++) {
    const y = padding.top + (chartHeight / ySteps) * i
    const value = maxValue - (maxValue / ySteps) * i
    ctx.fillText(formatLargeNumber(value), width - padding.right + 5, y + 4)
  }

  // [WHAT] 图例
  const legendY = height - 10
  ctx.fillStyle = colors.investColor
  ctx.fillRect(padding.left, legendY - 8, 12, 12)
  ctx.fillStyle = colors.text
  ctx.textAlign = 'left'
  ctx.fillText('本金', padding.left + 16, legendY)
  
  ctx.fillStyle = colors.profitColor
  ctx.fillRect(padding.left + 60, legendY - 8, 12, 12)
  ctx.fillText('收益', padding.left + 76, legendY)
}

// [WHAT] 格式化大数字
function formatLargeNumber(num: number): string {
  if (num >= 10000) {
    return (num / 10000).toFixed(1) + '万'
  }
  return num.toFixed(0)
}

// [WHAT] 格式化金额
function formatMoney(num: number): string {
  if (num >= 10000) {
    return (num / 10000).toFixed(2) + '万'
  }
  return num.toFixed(2)
}

// 监听参数变化重绘
watch([monthlyAmount, investYears, expectedReturn, investFrequency], () => {
  nextTick(drawChart)
})

// 监听主题变化
watch(() => themeStore.actualTheme, () => {
  nextTick(drawChart)
})

onMounted(() => {
  nextTick(drawChart)
  window.addEventListener('resize', drawChart)
})

onUnmounted(() => {
  window.removeEventListener('resize', drawChart)
})

function goBack() {
  router.back()
}
</script>

<template>
  <div class="calculator-page">
    <!-- 顶部导航 -->
    <van-nav-bar title="定投计算器" left-arrow @click-left="goBack" />

    <!-- 结果展示 -->
    <div class="result-card">
      <div class="result-header">
        <span class="result-label">预期总金额</span>
        <span class="result-value">¥{{ formatMoney(result.totalValue) }}</span>
      </div>
      <div class="result-grid">
        <div class="result-item">
          <span class="item-label">总投入</span>
          <span class="item-value">¥{{ formatMoney(result.totalInvest) }}</span>
        </div>
        <div class="result-item">
          <span class="item-label">预期收益</span>
          <span class="item-value profit">+¥{{ formatMoney(result.totalProfit) }}</span>
        </div>
        <div class="result-item">
          <span class="item-label">收益率</span>
          <span class="item-value profit">+{{ result.profitRate.toFixed(1) }}%</span>
        </div>
        <div class="result-item">
          <span class="item-label">定投期数</span>
          <span class="item-value">{{ investYears * (investFrequency === 'monthly' ? 12 : 52) }}期</span>
        </div>
      </div>
    </div>

    <!-- 图表 -->
    <div class="chart-section">
      <div class="section-title">资产增长曲线</div>
      <div class="chart-container">
        <canvas ref="canvasRef"></canvas>
      </div>
    </div>

    <!-- 参数设置 -->
    <div class="params-section">
      <div class="section-title">设置参数</div>
      
      <!-- 每月定投金额 -->
      <div class="param-item">
        <div class="param-header">
          <span class="param-label">每月定投</span>
          <span class="param-value">¥{{ monthlyAmount }}</span>
        </div>
        <van-slider v-model="monthlyAmount" :min="100" :max="10000" :step="100" />
        <div class="param-presets">
          <span 
            v-for="val in [500, 1000, 2000, 5000]" 
            :key="val"
            class="preset-btn"
            :class="{ active: monthlyAmount === val }"
            @click="monthlyAmount = val"
          >
            ¥{{ val }}
          </span>
        </div>
      </div>

      <!-- 定投年限 -->
      <div class="param-item">
        <div class="param-header">
          <span class="param-label">定投年限</span>
          <span class="param-value">{{ investYears }}年</span>
        </div>
        <van-slider v-model="investYears" :min="1" :max="30" :step="1" />
        <div class="param-presets">
          <span 
            v-for="val in yearPresets" 
            :key="val"
            class="preset-btn"
            :class="{ active: investYears === val }"
            @click="investYears = val"
          >
            {{ val }}年
          </span>
        </div>
      </div>

      <!-- 预期年化收益率 -->
      <div class="param-item">
        <div class="param-header">
          <span class="param-label">预期年化</span>
          <span class="param-value">{{ expectedReturn }}%</span>
        </div>
        <van-slider v-model="expectedReturn" :min="0" :max="20" :step="0.5" />
        <div class="param-presets">
          <span 
            v-for="preset in returnPresets" 
            :key="preset.value"
            class="preset-btn"
            :class="{ active: expectedReturn === preset.value }"
            @click="expectedReturn = preset.value"
          >
            {{ preset.label }}
          </span>
        </div>
      </div>

      <!-- 定投频率 -->
      <div class="param-item">
        <div class="param-header">
          <span class="param-label">定投频率</span>
        </div>
        <van-radio-group v-model="investFrequency" direction="horizontal">
          <van-radio name="monthly">每月</van-radio>
          <van-radio name="weekly">每周</van-radio>
        </van-radio-group>
      </div>
    </div>

    <!-- 说明 -->
    <div class="tips-section">
      <van-notice-bar 
        left-icon="info-o"
        text="计算结果仅供参考，实际收益受市场波动影响。定投不能保证盈利，但可以平滑成本。"
      />
    </div>
  </div>
</template>

<style scoped>
.calculator-page {
  min-height: 100vh;
  background: var(--bg-primary);
  padding-bottom: 20px;
  transition: background-color 0.3s;
}

/* 结果卡片 */
.result-card {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  margin: 12px;
  padding: 20px;
  border-radius: 12px;
  color: #fff;
}

.result-header {
  text-align: center;
  margin-bottom: 20px;
}

.result-label {
  display: block;
  font-size: 14px;
  opacity: 0.8;
  margin-bottom: 8px;
}

.result-value {
  font-size: 32px;
  font-weight: 600;
}

.result-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.result-item {
  text-align: center;
}

.result-item .item-label {
  display: block;
  font-size: 12px;
  opacity: 0.8;
  margin-bottom: 4px;
}

.result-item .item-value {
  font-size: 16px;
  font-weight: 500;
}

.result-item .item-value.profit {
  color: #90EE90;
}

/* 图表区域 */
.chart-section {
  margin: 12px;
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
}

.section-title {
  padding: 12px 16px;
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.chart-container {
  height: 200px;
  padding: 8px;
}

.chart-container canvas {
  width: 100%;
  height: 100%;
}

/* 参数设置 */
.params-section {
  margin: 12px;
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
}

.param-item {
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.param-item:last-child {
  border-bottom: none;
}

.param-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.param-label {
  font-size: 14px;
  color: var(--text-primary);
}

.param-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-primary);
}

.param-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.preset-btn {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 16px;
  cursor: pointer;
}

.preset-btn.active {
  color: #fff;
  background: var(--color-primary);
}

/* 说明 */
.tips-section {
  margin: 12px;
}

/* Slider 适配 */
:deep(.van-slider) {
  margin: 8px 0;
}

:deep(.van-slider__bar) {
  background: var(--color-primary);
}

:deep(.van-slider__button) {
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}
</style>
