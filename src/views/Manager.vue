<script setup lang="ts">
// [WHY] 基金经理详情页 - 展示经理背景、管理业绩、在管基金
// [WHAT] 从 pingzhongdata 获取经理信息，展示管理年限、历史业绩、管理规模

import { ref, onMounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchFundManagerInfo, fetchManagerProfit, type FundManagerInfo, type ManagerProfitPoint } from '@/api/fundFast'
import { showToast } from 'vant'

const route = useRoute()
const router = useRouter()

const fundCode = ref(route.params.code as string)
const manager = ref<FundManagerInfo | null>(null)
const profitData = ref<ManagerProfitPoint[]>([])
const loading = ref(true)
const chartCanvas = ref<HTMLCanvasElement | null>(null)

// [WHAT] 加载经理数据
async function loadManager() {
  loading.value = true
  try {
    manager.value = await fetchFundManagerInfo(fundCode.value)
    if (!manager.value) {
      showToast('暂无经理信息')
    }
    // [WHAT] 异步加载业绩走势
    fetchManagerProfit(fundCode.value).then(data => {
      profitData.value = data
      nextTick(() => drawProfitChart())
    })
  } catch {
    showToast('加载失败')
  } finally {
    loading.value = false
  }
}

// [WHAT] 绘制业绩走势图
function drawProfitChart() {
  const canvas = chartCanvas.value
  if (!canvas || profitData.value.length < 2) return
  
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  
  // [WHAT] 高清适配
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)
  
  const width = rect.width
  const height = rect.height
  const padding = { top: 20, right: 16, bottom: 30, left: 50 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  
  // [WHAT] 获取数据范围
  const data = profitData.value
  const values = data.map(d => d.profit)
  const minVal = Math.min(...values, 0)
  const maxVal = Math.max(...values, 0)
  const range = maxVal - minVal || 1
  
  // [WHAT] 获取主题颜色
  const style = getComputedStyle(document.documentElement)
  const textColor = style.getPropertyValue('--text-secondary').trim() || '#888'
  const gridColor = style.getPropertyValue('--border-color').trim() || '#333'
  const upColor = style.getPropertyValue('--color-up').trim() || '#e74c3c'
  const downColor = style.getPropertyValue('--color-down').trim() || '#2ecc71'
  
  // [WHAT] 清除画布
  ctx.clearRect(0, 0, width, height)
  
  // [WHAT] 绘制网格线
  ctx.strokeStyle = gridColor
  ctx.lineWidth = 0.5
  const gridLines = 4
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (chartHeight / gridLines) * i
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(width - padding.right, y)
    ctx.stroke()
    
    // Y轴标签
    const val = maxVal - (range / gridLines) * i
    ctx.fillStyle = textColor
    ctx.font = '11px system-ui'
    ctx.textAlign = 'right'
    ctx.fillText(`${val.toFixed(1)}%`, padding.left - 8, y + 4)
  }
  
  // [WHAT] 绘制0%基准线
  if (minVal < 0 && maxVal > 0) {
    const zeroY = padding.top + ((maxVal - 0) / range) * chartHeight
    ctx.strokeStyle = textColor
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(padding.left, zeroY)
    ctx.lineTo(width - padding.right, zeroY)
    ctx.stroke()
    ctx.setLineDash([])
  }
  
  // [WHAT] 计算数据点坐标
  const points = data.map((d, i) => ({
    x: padding.left + (i / (data.length - 1)) * chartWidth,
    y: padding.top + ((maxVal - d.profit) / range) * chartHeight,
    profit: d.profit,
    date: d.date
  }))
  
  // [WHAT] 绘制渐变填充
  const lastData = data[data.length - 1]!
  const lastProfit = lastData.profit
  const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom)
  const lineColor = lastProfit >= 0 ? upColor : downColor
  gradient.addColorStop(0, `${lineColor}30`)
  gradient.addColorStop(1, `${lineColor}05`)
  
  const firstPoint = points[0]!
  const lastPoint = points[points.length - 1]!
  
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.moveTo(firstPoint.x, height - padding.bottom)
  points.forEach(p => ctx.lineTo(p.x, p.y))
  ctx.lineTo(lastPoint.x, height - padding.bottom)
  ctx.closePath()
  ctx.fill()
  
  // [WHAT] 绘制曲线
  ctx.strokeStyle = lineColor
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(firstPoint.x, firstPoint.y)
  points.forEach(p => ctx.lineTo(p.x, p.y))
  ctx.stroke()
  
  // [WHAT] X轴日期标签
  ctx.fillStyle = textColor
  ctx.font = '10px system-ui'
  ctx.textAlign = 'center'
  const labelCount = Math.min(4, data.length)
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.floor(i * (data.length - 1) / (labelCount - 1))
    const labelData = data[idx]
    const labelPoint = points[idx]
    if (labelData && labelPoint) {
      ctx.fillText(labelData.date.slice(5), labelPoint.x, height - 8)
    }
  }
  
  // [WHAT] 绘制最新收益标记
  ctx.fillStyle = lineColor
  ctx.beginPath()
  ctx.arc(lastPoint.x, lastPoint.y, 4, 0, Math.PI * 2)
  ctx.fill()
  
  // [WHAT] 显示最新收益
  ctx.fillStyle = lineColor
  ctx.font = 'bold 12px system-ui'
  ctx.textAlign = 'right'
  ctx.fillText(`${lastProfit >= 0 ? '+' : ''}${lastProfit.toFixed(2)}%`, width - padding.right, padding.top - 6)
}

// [WHAT] 主题变化时重绘
watch(() => document.documentElement.getAttribute('data-theme'), () => {
  nextTick(() => drawProfitChart())
})

// [WHAT] 跳转到基金详情
function goToFund(code: string) {
  router.push(`/detail/${code}`)
}

// [WHAT] 返回格式化的收益率样式类
function getReturnClass(rate: string): string {
  const num = parseFloat(rate)
  if (isNaN(num)) return ''
  return num >= 0 ? 'up' : 'down'
}

onMounted(loadManager)
</script>

<template>
  <div class="manager-page">
    <!-- 导航栏 -->
    <van-nav-bar 
      title="基金经理" 
      left-arrow 
      @click-left="router.back()"
    />
    
    <!-- 加载状态 -->
    <div v-if="loading" class="loading-container">
      <van-loading size="36px" color="var(--color-primary)">加载中...</van-loading>
    </div>
    
    <!-- 空状态 -->
    <van-empty v-else-if="!manager" description="暂无经理信息" />
    
    <!-- 经理信息 -->
    <template v-else>
      <!-- 头部信息卡片 -->
      <div class="manager-header">
        <div class="avatar-section">
          <img 
            v-if="manager.photo" 
            :src="manager.photo" 
            class="avatar"
            @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'"
          />
          <div v-else class="avatar-placeholder">
            <van-icon name="manager" size="32" />
          </div>
        </div>
        
        <div class="info-section">
          <h2 class="manager-name">{{ manager.name }}</h2>
          <div class="meta-row">
            <span class="meta-item">
              <van-icon name="clock-o" />
              从业 {{ manager.workTime }}
            </span>
          </div>
        </div>
      </div>
      
      <!-- 核心指标 -->
      <div class="stats-card">
        <div class="stat-item">
          <span class="stat-label">管理规模</span>
          <span class="stat-value">{{ manager.fundSize }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">最佳回报</span>
          <span class="stat-value" :class="getReturnClass(manager.bestReturn)">
            {{ manager.bestReturn }}
          </span>
        </div>
        <div class="stat-item">
          <span class="stat-label">在管基金</span>
          <span class="stat-value">{{ manager.funds.length }}只</span>
        </div>
      </div>
      
      <!-- 业绩走势图 -->
      <div v-if="profitData.length > 0" class="section chart-section">
        <div class="section-title">任职收益走势</div>
        <div class="chart-container">
          <canvas ref="chartCanvas" class="profit-chart"></canvas>
        </div>
      </div>
      
      <!-- 简介 -->
      <div v-if="manager.experience" class="section">
        <div class="section-title">从业经历</div>
        <div class="experience-text">{{ manager.experience }}</div>
      </div>
      
      <!-- 管理的基金列表 -->
      <div class="section">
        <div class="section-title">在管基金</div>
        <div class="fund-list" v-if="manager.funds.length > 0">
          <div 
            v-for="fund in manager.funds" 
            :key="fund.code"
            class="fund-item"
            @click="goToFund(fund.code)"
          >
            <div class="fund-main">
              <span class="fund-name">{{ fund.name }}</span>
              <span class="fund-code">{{ fund.code }}</span>
            </div>
            <div class="fund-meta">
              <span class="fund-type">{{ fund.type }}</span>
              <span class="fund-size">规模: {{ fund.size }}</span>
            </div>
            <div class="fund-return">
              <span class="return-label">任职回报</span>
              <span class="return-value" :class="getReturnClass(fund.returnRate)">
                {{ fund.returnRate }}
              </span>
            </div>
            <div class="fund-date">
              任职日期: {{ fund.startDate }}
            </div>
          </div>
        </div>
        <!-- 暂无数据时显示提示 -->
        <div v-else class="empty-hint">
          <p>受接口限制，暂无法获取基金列表</p>
          <p class="sub-hint">可从基金详情页查看该基金信息</p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.manager-page {
  min-height: 100vh;
  background: var(--bg-primary);
  padding-bottom: env(safe-area-inset-bottom);
}

.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 60px 0;
}

/* 头部信息 */
.manager-header {
  display: flex;
  align-items: center;
  padding: 20px 16px;
  background: var(--bg-secondary);
  gap: 16px;
}

.avatar-section {
  flex-shrink: 0;
}

.avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid var(--border-color);
}

.avatar-placeholder {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: var(--bg-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.info-section {
  flex: 1;
  min-width: 0;
}

.manager-name {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

/* 核心指标卡片 */
.stats-card {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--border-color);
  margin: 12px 16px;
  border-radius: 12px;
  overflow: hidden;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 8px;
  background: var(--bg-secondary);
  gap: 6px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  font-family: 'DIN Alternate', 'Roboto Mono', monospace;
}

.stat-value.up { color: var(--color-up); }
.stat-value.down { color: var(--color-down); }

/* 业绩走势图 */
.chart-section {
  padding-bottom: 8px !important;
}

.chart-container {
  width: 100%;
  height: 200px;
  margin-top: 12px;
}

.profit-chart {
  width: 100%;
  height: 100%;
}

/* 通用区块 */
.section {
  margin: 12px 16px;
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 16px;
}

.section-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.experience-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
}

/* 基金列表 */
.fund-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.fund-item {
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.fund-item:active {
  background: var(--bg-primary);
}

.fund-main {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.fund-name {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fund-code {
  font-size: 12px;
  color: var(--text-muted);
  font-family: 'Roboto Mono', monospace;
}

.fund-meta {
  display: flex;
  gap: 12px;
  margin-bottom: 6px;
}

.fund-type,
.fund-size {
  font-size: 12px;
  color: var(--text-secondary);
}

.fund-return {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.return-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.return-value {
  font-size: 14px;
  font-weight: 600;
  font-family: 'DIN Alternate', 'Roboto Mono', monospace;
}

.return-value.up { color: var(--color-up); }
.return-value.down { color: var(--color-down); }

.fund-date {
  font-size: 11px;
  color: var(--text-muted);
}

/* 空数据提示 */
.empty-hint {
  text-align: center;
  padding: 24px 16px;
  color: var(--text-secondary);
  font-size: 14px;
}

.empty-hint .sub-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 8px;
}

/* 移动端适配 */
@media (max-width: 400px) {
  .avatar {
    width: 60px;
    height: 60px;
  }
  
  .avatar-placeholder {
    width: 60px;
    height: 60px;
  }
  
  .manager-name {
    font-size: 18px;
  }
  
  .stat-value {
    font-size: 14px;
  }
}
</style>
