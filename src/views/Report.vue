<script setup lang="ts">
// [WHY] 收益报告页面 - 生成可分享的收益报告图片
// [WHAT] 汇总持仓收益数据，使用 Canvas 生成精美报告图片

import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useHoldingStore } from '@/stores/holding'
import { useTradeStore } from '@/stores/trade'
import { showToast, showLoadingToast, closeToast } from 'vant'

const router = useRouter()
const holdingStore = useHoldingStore()
const tradeStore = useTradeStore()

// 报告类型
const reportType = ref<'weekly' | 'monthly' | 'yearly'>('monthly')

// Canvas 引用
const reportCanvas = ref<HTMLCanvasElement | null>(null)

// 报告数据
interface ReportData {
  period: string
  periodStart: string
  periodEnd: string
  totalValue: number
  totalCost: number
  totalProfit: number
  profitRate: number
  todayProfit: number
  holdingCount: number
  tradeCount: number
  buyAmount: number
  sellAmount: number
  topHoldings: { name: string; value: number; profit: number; rate: number }[]
}

const reportData = ref<ReportData | null>(null)

// [WHAT] 计算报告周期
function getReportPeriod(type: 'weekly' | 'monthly' | 'yearly'): { start: Date; end: Date; label: string } {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let start: Date
  let label: string
  
  switch (type) {
    case 'weekly':
      start = new Date(end)
      start.setDate(start.getDate() - 7)
      label = '周报'
      break
    case 'monthly':
      start = new Date(end)
      start.setMonth(start.getMonth() - 1)
      label = '月报'
      break
    case 'yearly':
      start = new Date(end)
      start.setFullYear(start.getFullYear() - 1)
      label = '年报'
      break
  }
  
  return { start, end, label }
}

// [WHAT] 格式化日期
function formatDate(date: Date): string {
  return `${date.getFullYear()}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getDate().toString().padStart(2, '0')}`
}

// [WHAT] 生成报告数据
function generateReportData() {
  const { start, end, label } = getReportPeriod(reportType.value)
  
  // 获取持仓汇总
  const summary = holdingStore.summary
  
  // 获取时间段内的交易
  const trades = tradeStore.trades.filter(t => {
    const tradeDate = new Date(t.date)
    return tradeDate >= start && tradeDate <= end
  })
  
  // 统计交易数据
  let buyAmount = 0
  let sellAmount = 0
  trades.forEach(t => {
    if (t.type === 'buy') buyAmount += t.amount
    else if (t.type === 'sell') sellAmount += t.amount
  })
  
  // 获取持仓排名
  const topHoldings = holdingStore.holdings
    .filter(h => h.marketValue !== undefined && h.marketValue > 0)
    .sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0))
    .slice(0, 5)
    .map(h => ({
      name: h.name || h.code,
      value: h.marketValue || 0,
      profit: h.profit || 0,
      rate: h.profitRate || 0
    }))
  
  reportData.value = {
    period: label,
    periodStart: formatDate(start),
    periodEnd: formatDate(end),
    totalValue: summary.totalValue,
    totalCost: summary.totalCost,
    totalProfit: summary.totalProfit,
    profitRate: summary.totalProfitRate,
    todayProfit: summary.todayProfit,
    holdingCount: holdingStore.holdings.length,
    tradeCount: trades.length,
    buyAmount,
    sellAmount,
    topHoldings
  }
}

// [WHAT] 绘制报告图片
async function drawReport() {
  if (!reportCanvas.value || !reportData.value) return
  
  const canvas = reportCanvas.value
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  
  const dpr = window.devicePixelRatio || 2
  const width = 375 * dpr
  const height = 600 * dpr
  
  canvas.width = width
  canvas.height = height
  ctx.scale(dpr, dpr)
  
  const data = reportData.value
  const w = 375
  const h = 600
  
  // 背景渐变
  const gradient = ctx.createLinearGradient(0, 0, 0, h)
  gradient.addColorStop(0, '#1a1a2e')
  gradient.addColorStop(1, '#16213e')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, w, h)
  
  // 标题
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 24px -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(`投资${data.period}`, w / 2, 50)
  
  // 时间范围
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = '14px -apple-system, sans-serif'
  ctx.fillText(`${data.periodStart} - ${data.periodEnd}`, w / 2, 75)
  
  // 总资产卡片
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  roundRect(ctx, 20, 100, w - 40, 120, 12)
  ctx.fill()
  
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = '13px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('总资产(元)', 40, 130)
  
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 32px -apple-system, sans-serif'
  ctx.fillText(formatMoney(data.totalValue), 40, 170)
  
  // 收益信息
  const profitColor = data.totalProfit >= 0 ? '#0ecb81' : '#f6465d'
  ctx.fillStyle = profitColor
  ctx.font = 'bold 18px -apple-system, sans-serif'
  const profitText = `${data.totalProfit >= 0 ? '+' : ''}${formatMoney(data.totalProfit)} (${data.profitRate >= 0 ? '+' : ''}${data.profitRate.toFixed(2)}%)`
  ctx.fillText(profitText, 40, 205)
  
  // 统计网格
  const statsY = 250
  const gridItems = [
    { label: '持仓数', value: `${data.holdingCount}只` },
    { label: '交易次数', value: `${data.tradeCount}次` },
    { label: '买入', value: `¥${formatMoney(data.buyAmount)}` },
    { label: '卖出', value: `¥${formatMoney(data.sellAmount)}` }
  ]
  
  const itemWidth = (w - 60) / 2
  gridItems.forEach((item, i) => {
    const x = 30 + (i % 2) * itemWidth
    const y = statsY + Math.floor(i / 2) * 55
    
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.font = '12px -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(item.label, x, y)
    
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 16px -apple-system, sans-serif'
    ctx.fillText(item.value, x, y + 22)
  })
  
  // 持仓排名
  if (data.topHoldings.length > 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.font = '13px -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('持仓TOP5', 30, 380)
    
    data.topHoldings.forEach((holding, i) => {
      const y = 405 + i * 35
      
      // 名称
      ctx.fillStyle = '#fff'
      ctx.font = '14px -apple-system, sans-serif'
      ctx.textAlign = 'left'
      const displayName = holding.name.length > 10 ? holding.name.slice(0, 10) + '...' : holding.name
      ctx.fillText(displayName, 30, y)
      
      // 收益率
      const rateColor = holding.rate >= 0 ? '#0ecb81' : '#f6465d'
      ctx.fillStyle = rateColor
      ctx.font = 'bold 14px -apple-system, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(`${holding.rate >= 0 ? '+' : ''}${holding.rate.toFixed(2)}%`, w - 30, y)
    })
  }
  
  // 底部水印
  ctx.fillStyle = 'rgba(255,255,255,0.3)'
  ctx.font = '11px -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('基金估值助手 · 投资有风险', w / 2, h - 30)
}

// [WHAT] 绘制圆角矩形
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// [WHAT] 格式化金额
function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// [WHAT] 保存图片
async function saveImage() {
  if (!reportCanvas.value) return
  
  const loading = showLoadingToast({ message: '生成中...', duration: 0 })
  
  try {
    await nextTick()
    await drawReport()
    
    // 转换为图片
    const dataUrl = reportCanvas.value.toDataURL('image/png')
    
    // 创建下载链接
    const link = document.createElement('a')
    link.download = `投资报告_${reportData.value?.periodStart}_${reportData.value?.periodEnd}.png`
    link.href = dataUrl
    link.click()
    
    showToast('已保存到相册')
  } catch (err) {
    console.error('保存失败:', err)
    showToast('保存失败')
  } finally {
    closeToast()
  }
}

// [WHAT] 分享图片（移动端）
async function shareImage() {
  if (!reportCanvas.value) return
  
  const loading = showLoadingToast({ message: '生成中...', duration: 0 })
  
  try {
    await nextTick()
    await drawReport()
    
    // 转换为 Blob
    const blob = await new Promise<Blob>((resolve, reject) => {
      reportCanvas.value!.toBlob(blob => {
        if (blob) resolve(blob)
        else reject(new Error('生成图片失败'))
      }, 'image/png')
    })
    
    // 检查是否支持 Web Share API
    if (navigator.share && navigator.canShare) {
      const file = new File([blob], 'report.png', { type: 'image/png' })
      const shareData = { files: [file] }
      
      if (navigator.canShare(shareData)) {
        await navigator.share(shareData)
        showToast('分享成功')
        return
      }
    }
    
    // 不支持分享则下载
    saveImage()
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      console.error('分享失败:', err)
      showToast('分享失败，已保存到本地')
      saveImage()
    }
  } finally {
    closeToast()
  }
}

// [WHAT] 切换报告类型
function switchType(type: 'weekly' | 'monthly' | 'yearly') {
  reportType.value = type
  generateReportData()
  nextTick(() => drawReport())
}

// 初始化
onMounted(async () => {
  await holdingStore.initHoldings()
  generateReportData()
  await nextTick()
  drawReport()
})
</script>

<template>
  <div class="report-page">
    <!-- 导航栏 -->
    <van-nav-bar 
      title="收益报告" 
      left-arrow 
      @click-left="router.back()"
    />
    
    <!-- 报告类型切换 -->
    <div class="type-bar">
      <span 
        class="type-btn" 
        :class="{ active: reportType === 'weekly' }"
        @click="switchType('weekly')"
      >周报</span>
      <span 
        class="type-btn" 
        :class="{ active: reportType === 'monthly' }"
        @click="switchType('monthly')"
      >月报</span>
      <span 
        class="type-btn" 
        :class="{ active: reportType === 'yearly' }"
        @click="switchType('yearly')"
      >年报</span>
    </div>
    
    <!-- 报告预览 -->
    <div class="report-preview">
      <canvas ref="reportCanvas" class="report-canvas"></canvas>
    </div>
    
    <!-- 操作按钮 -->
    <div class="action-bar">
      <van-button 
        type="primary" 
        icon="share-o"
        @click="shareImage"
      >
        分享报告
      </van-button>
      <van-button 
        icon="down"
        @click="saveImage"
      >
        保存图片
      </van-button>
    </div>
  </div>
</template>

<style scoped>
.report-page {
  min-height: 100vh;
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
}

/* 类型切换 */
.type-bar {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding: 16px;
  background: var(--bg-secondary);
}

.type-btn {
  padding: 8px 20px;
  font-size: 14px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 20px;
  cursor: pointer;
  transition: all 0.2s;
}

.type-btn.active {
  color: #fff;
  background: var(--color-primary);
}

/* 报告预览 */
.report-preview {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 16px;
  overflow: hidden;
}

.report-canvas {
  max-width: 100%;
  max-height: 100%;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

/* 操作按钮 */
.action-bar {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: var(--bg-secondary);
  padding-bottom: calc(16px + env(safe-area-inset-bottom));
}

.action-bar .van-button {
  flex: 1;
}
</style>
