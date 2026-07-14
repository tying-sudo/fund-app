<script setup lang="ts">
// [WHY] 专业交易所风格图表组件 - 从APK恢复版本
// [WHAT] 深色主题、实时K线图、成交量柱状图、时间周期选择、十字光标、复权净值
// [HOW] Canvas绘制，requestAnimationFrame实现流畅实时动画

import { ref, onMounted, onUnmounted, watch, computed, nextTick } from 'vue'
import { fetchSimpleKLineData, calculatePeriodReturns, clearFundCache, type SimpleKLineData, type PeriodReturn } from '@/api/fundFast'
import { fetchTimeShareData } from '@/api/fund'
import { useThemeStore } from '@/stores/theme'

const props = defineProps<{
  fundCode: string
  realtimeValue: number
  realtimeChange: number
  lastClose: number
}>()

const emit = defineEmits<{
  (e: 'stats-update', stats: { high: number; low: number; open: number; close: number }): void
}>()

const themeStore = useThemeStore()

// [WHY] 根据主题获取颜色
function getThemeColors() {
  const isDark = themeStore.actualTheme === 'dark'
  return {
    bgPrimary: isDark ? '#0b0e11' : '#ffffff',
    bgSecondary: isDark ? '#1e2329' : '#f5f5f5',
    textPrimary: isDark ? '#eaecef' : '#1a1a1a',
    textSecondary: isDark ? '#848e9c' : '#666666',
    borderColor: isDark ? '#2b3139' : '#e0e0e0',
    gridColor: isDark ? '#1e2329' : '#f0f0f0',
    upColor: '#f6465d',
    downColor: '#0ecb81',
  }
}

// ========== 状态 ==========
const chartData = ref<SimpleKLineData[]>([])
const periodReturns = ref<PeriodReturn[]>([])
const isLoading = ref(false)
const activePeriod = ref('1d') // 默认显示当日
const canvasRef = ref<HTMLCanvasElement | null>(null)

// [WHAT] 分时数据
interface IntradayPoint {
  time: string
  value: number
  volume: number
  change?: number
}
const intradayData = ref<IntradayPoint[]>([])
const baseValue = ref(0)

// ========== 十字光标状态 ==========
const crosshairVisible = ref(false)
const crosshairX = ref(0)
const crosshairY = ref(0)
const crosshairDataIdx = ref(-1)

// [WHAT] 复权净值
const showAccNav = ref(false)
const accNavData = ref<{ time: string; value: number }[]>([])
const accNavLoading = ref(false)

// [WHAT] 时间周期配置
const periods = [
  { key: '1d', label: '当日', days: 0 },
  { key: '5d', label: '近5日', days: 5 },
  { key: '1m', label: '近1月', days: 30 },
  { key: '3m', label: '近3月', days: 90 },
  { key: '6m', label: '近6月', days: 180 },
  { key: '1y', label: '近1年', days: 365 },
  { key: '3y', label: '近3年', days: 1095 },
  { key: '5y', label: '近5年', days: 1825 },
  { key: 'ytd', label: '今年来', days: -1 }, // 特殊处理：今年至今
  { key: 'since', label: '成立以来', days: -2 }, // 特殊处理：基金成立至今
]

// 默认显示的周期数量（超出部分折叠）
const defaultVisibleCount = 6
const showAllPeriods = ref(false)
const visiblePeriods = computed(() => {
  return periods
})
const hasMorePeriods = computed(() => periods.length > defaultVisibleCount)
const isIntradayMode = computed(() => activePeriod.value === '1d')
const showIntradayChart = computed(() => isIntradayMode.value)

// [WHAT] 交易状态
const tradingStatus = computed(() => {
  if (!isIntradayMode.value) return 'other'
  const now = new Date()
  const day = now.getDay()
  if (day === 0 || day === 6) return 'non_trading'
  const h = now.getHours()
  const m = now.getMinutes()
  const totalMinutes = h * 60 + m
  if (totalMinutes >= 570 && totalMinutes <= 900) return 'trading_realtime'
  if (totalMinutes > 900) return 'trading_closed'
  return 'non_trading'
})

// [WHAT] 过滤数据
const filteredData = computed(() => {
  const currentPeriod = activePeriod.value
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    // 当日模式
  if (showIntradayChart.value) {
    const status = tradingStatus.value
    if (intradayData.value.length > 0) {
      // [WHAT] 真实数据也需要根据当前时间截断
      let data = intradayData.value.map((item, i) => ({
        time: item.time,
        value: item.value,
        change: item.change || 0,
        volume: 50 + Math.abs(item.change || 0) * 30
      }))
            // 盘中时，只显示到当前时间的数据
      if (status === 'trading_realtime') {
        const currentHour = now.getHours()
        const currentMinute = now.getMinutes()
        const currentTotalMinutes = currentHour * 60 + currentMinute
        data = data.filter((item) => {
          // 时间格式可能是 "HH:mm:ss" 或 "YYYY-MM-DD HH:mm:ss"
          const timeStr = item.time.includes(' ') ? item.time.split(' ')[1] : item.time
          const timeParts = timeStr?.split(':')
          if (!timeParts || timeParts.length < 2) return true
          const itemMinutes = parseInt(timeParts[0]) * 60 + parseInt(timeParts[1])
          return itemMinutes <= currentTotalMinutes
        })
      }
      return data
    }
        // 生成模拟数据
    const generateIntraday = () => {
      const result: any[] = []
      const lastClose = props.lastClose || 1
      const realtime = props.realtimeValue > 0 ? props.realtimeValue : lastClose
      const change = realtime - lastClose
      const totalPoints = 241 // 9:30-15:00 完整交易时间
      const timePoints: { hour: number; minute: number }[] = []
      for (let i = 0; i <= 120; i++) {
        const h = 9 + Math.floor((30 + i) / 60)
        const m = (30 + i) % 60
        timePoints.push({ hour: h, minute: m })
      }
      for (let i = 0; i <= 120; i++) {
        const h = 13 + Math.floor(i / 60)
        const m = i % 60
        timePoints.push({ hour: h, minute: m })
      }
      
      // [WHAT] 根据当前时间计算应该显示的点数
      const currentHour = now.getHours()
      const currentMinute = now.getMinutes()
      const currentTotalMinutes = currentHour * 60 + currentMinute
      let maxPoints = totalPoints
      if (currentTotalMinutes < 570) {
        // 9:30 之前，显示 0 个点
        maxPoints = 0
      } else if (currentTotalMinutes <= 900) {
        // 9:30-15:00 之间，根据当前时间计算点数
        maxPoints = Math.min(totalPoints, (currentTotalMinutes - 570) + 1)
      }
      // 15:00 之后显示完整数据
      
      let seed = props.fundCode.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + now.getDate()
      const random = () => { seed = (seed * 16807) % 2147483647; return (seed & 2147483647) / 2147483647 }
      const values: number[] = [lastClose]
      for (let i = 1; i < totalPoints; i++) {
        const t = i / totalPoints
        let target: number
        if (t < 0.15) target = lastClose + change * Math.pow(t / 0.15, 0.6)
        else if (t > 0.85) target = lastClose + change * (0.85 + Math.pow((t - 0.85) / 0.15, 0.7) * 0.15)
        else target = lastClose + change * (0.15 + (t - 0.15) * 0.7 / 0.7)
        const noise = Math.abs(change) * 0.12
        const prev = values[i - 1] * 0.45 + target * 0.55
        values.push(prev + (random() - 0.5) * noise)
      }
      values[values.length - 1] = realtime
      
      // [WHAT] 只生成到当前时间的数据点
      for (let i = 0; i < maxPoints; i++) {
        const tp = timePoints[i]
        const time = `${today} ${String(tp.hour).padStart(2, '0')}:${String(tp.minute).padStart(2, '0')}`
        const value = values[i]
        const changePct = ((value - lastClose) / lastClose) * 100
        result.push({ time, value: parseFloat(value.toFixed(4)), change: parseFloat(changePct.toFixed(4)), volume: 50 + Math.abs(changePct) * 30 })
      }
      return result
    }
        if (status === 'trading_realtime' || status === 'trading_closed') {
      // [WHAT] 优先使用真实分时数据，没有则降级到模拟数据
      if (intradayData.value.length > 0) {
        let data = intradayData.value.map(item => ({
          time: item.time,
          value: item.value,
          change: item.change || 0,
          volume: item.volume || 50
        }))
        // 盘中时，只显示到当前时间的数据
        if (status === 'trading_realtime') {
          const currentHour = now.getHours()
          const currentMinute = now.getMinutes()
          const currentTotalMinutes = currentHour * 60 + currentMinute
          data = data.filter((item) => {
            const timeStr = item.time.includes(' ') ? item.time.split(' ')[1] : item.time
            const timeParts = timeStr?.split(':')
            if (!timeParts || timeParts.length < 2) return true
            const itemMinutes = parseInt(timeParts[0]) * 60 + parseInt(timeParts[1])
            return itemMinutes <= currentTotalMinutes
          })
        }
        return data
      }
      return generateIntraday()
    }
    if (status === 'non_trading') {
      const twoDaysAgo = new Date(now.getTime() - 432000000)
      const data = chartData.value.filter(d => new Date(d.time) >= twoDaysAgo && d.time !== today).map((d, i) => ({ ...d, volume: 50 + Math.abs(d.change) * 30 + (i % 5) * 10 }))
      return data.length > 0 ? data : [{ time: today, value: props.lastClose || 1, change: 0, volume: 50 }]
    }
    const weekAgo = new Date(now.getTime() - 7200 * 60 * 1000)
    const data = chartData.value.filter(d => new Date(d.time) >= weekAgo).map((d, i) => ({ ...d, volume: 50 + Math.abs(d.change) * 30 + (i % 5) * 10 }))
    return data.length > 0 ? data : [{ time: today, value: props.lastClose || 1, change: 0, volume: 50 }]
  }

    // 其他周期
  const period = periods.find(p => p.key === currentPeriod)
  let data = chartData.value

  // 处理特殊周期
  if (currentPeriod === 'ytd') {
    // 今年来：从今年1月1日开始
    const yearStart = `${now.getFullYear()}-01-01`
    data = chartData.value.filter(d => d.time >= yearStart)
  } else if (currentPeriod === 'since') {
    // 成立以来：显示所有数据
    data = chartData.value
  } else {
    // 普通周期
    const days = (period?.days === 0 || !period) ? 5 : period.days
    if (currentPeriod !== 'all') {
      data = chartData.value.filter(d => {
        const dayOfWeek = new Date(d.time).getDay()
        return dayOfWeek !== 0 && dayOfWeek !== 6
      }).slice(-days)
    }
  }
  let result = data.map((d, i) => ({ ...d, volume: 50 + Math.abs(d.change) * 30 + (i % 5) * 10 }))
  if (props.realtimeValue > 0 && result.length > 0) {
    const lastIdx = result.length - 1
    const lastItem = result[lastIdx]
    if (lastItem.time === today) {
      result = [...result.slice(0, lastIdx), { ...lastItem, value: props.realtimeValue, change: props.realtimeChange, volume: lastItem.volume }]
    } else {
      result = [...result, { time: today, value: props.realtimeValue, change: props.realtimeChange, volume: 50 + Math.abs(props.realtimeChange) * 30 }]
    }
  }
  return result
})

// [WHAT] 涨跌幅
const currentChange = computed(() => {
  // [WHY] 收盘后使用真实涨跌幅（props.realtimeChange）
  if (tradingStatus.value === 'trading_closed') {
    return props.realtimeChange || 0
  }
  // [WHY] 盘中使用估值计算涨跌幅
  if (isIntradayMode.value && baseValue.value > 0 && props.realtimeValue > 0) {
    return ((props.realtimeValue - baseValue.value) / baseValue.value) * 100
  }
  return props.realtimeChange || 0
})

// [WHAT] OHLC数据 - 开高低只用盘中估值数据，收可以用真实净值
const ohlcData = computed(() => {
  const data = filteredData.value
  if (data.length === 0) return { open: 0, high: 0, low: 0, close: 0 }
  const values = data.map(d => d.value)
  // [WHY] 收盘后使用真实净值作为收盘价
  const closeValue = tradingStatus.value === 'trading_closed' && props.realtimeValue > 0
    ? props.realtimeValue
    : data[data.length - 1]?.value || 0
  return {
    open: data[0]?.value || 0,
    high: Math.max(...values),
    low: Math.min(...values),
    close: closeValue
  }
})

// [WHAT] 发送stats-update
watch(ohlcData, (val) => {
  if (val.high > 0 && val.low > 0) emit('stats-update', val)
}, { immediate: true })

// [WHAT] 添加实时数据点
function addRealtimePoint(value: number) {
  if (!value || value <= 0) return
  const now = new Date()
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  if (baseValue.value === 0) baseValue.value = props.lastClose || value
  const lastVal = intradayData.value.length > 0 ? intradayData.value[intradayData.value.length - 1].value : value
  const volume = 100 + Math.abs(value - lastVal) * 10000 + Math.random() * 50
  const maxPoints = 500
  if (intradayData.value.length >= maxPoints) intradayData.value = intradayData.value.slice(-maxPoints + 1)
  intradayData.value.push({ time, value, volume })
}

function resetIntraday() {
  intradayData.value = []
  baseValue.value = props.lastClose || 0
}

// [WHAT] 加载复权净值
async function loadAccNav() {
  if (!props.fundCode || accNavData.value.length > 0) return
  accNavLoading.value = true
  return new Promise<void>((resolve) => {
    const scriptId = `accnav_${Date.now()}`
    const timeout = setTimeout(() => { cleanup(); accNavLoading.value = false; resolve() }, 10000)
    const script = document.createElement('script')
    script.id = scriptId
    // [WHAT] 生产环境使用后端代理，开发环境直接调用
    const isDev = import.meta.env.DEV
    const baseUrl = isDev ? 'https://fund.eastmoney.com' : `${window.location.origin}/api/tiantian`
    script.src = `${baseUrl}/pingzhongdata/${props.fundCode}.js?_=${Date.now()}`
    script.onload = () => {
      cleanup()
      try {
        const raw = (window as any).Data_ACWorthTrend || []
        accNavData.value = raw.map((item: any[]) => {
          const d = new Date(item[0])
          return { time: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, value: item[1] || 0 }
        }).filter((item: any) => item.value > 0)
      } catch (e) { console.error('解析复权净值失败:', e) }
      accNavLoading.value = false
      resolve()
    }
    script.onerror = () => { cleanup(); accNavLoading.value = false; resolve() }
    function cleanup() { clearTimeout(timeout); const el = document.getElementById(scriptId); if (el) document.body.removeChild(el) }
    document.body.appendChild(script)
  })
}

function toggleAccNav() {
  showAccNav.value = !showAccNav.value
  if (showAccNav.value && accNavData.value.length === 0) {
    loadAccNav().then(() => drawChart())
  } else {
    drawChart()
  }
}

// [WHAT] 加载数据
async function loadData() {
  if (!props.fundCode) return
  isLoading.value = true
  try {
    clearFundCache(props.fundCode)
    const [kline, returns] = await Promise.all([
      fetchSimpleKLineData(props.fundCode, 1500),
      calculatePeriodReturns(props.fundCode)
    ])
    chartData.value = kline
    periodReturns.value = returns
        await loadIntradayData()
    await loadAccNav()
    drawChart()
    startAnimation()
  } catch (e) {
    console.error('加载图表数据失败:', e)
  } finally {
    isLoading.value = false
  }
}

// [WHAT] 加载分时数据（使用真实API）
async function loadIntradayData() {
  if (!props.fundCode) return
  const now = new Date()
  const h = now.getHours(), m = now.getMinutes()
  const day = now.getDay()
  // 周末不加载
  if (day === 0 || day === 6) return
  // 盘后（15:00后）且已有数据则不重新加载
  if (h * 60 + m > 900 && intradayData.value.length > 0) return

    try {
    // [WHAT] 调用真实分时数据API
    console.log('[分时] 开始加载分时数据，基金代码:', props.fundCode)
    const timeShareData = await fetchTimeShareData(props.fundCode)
    console.log('[分时] API返回数据:', timeShareData.length, '条', timeShareData.slice(0, 3))
    if (timeShareData.length > 0) {
      intradayData.value = timeShareData.map(item => ({
        time: item.time,
        value: item.value,
        volume: 50 + Math.abs(item.change || 0) * 30,
        change: item.change || 0
      }))
      // [WHAT] 设置基准值
      if (intradayData.value.length > 0) {
        baseValue.value = props.lastClose || intradayData.value[0].value
      }
      console.log('[分时] 数据已设置，共', intradayData.value.length, '条')
    } else {
      console.log('[分时] API返回空数据，将使用模拟数据')
    }
  } catch (e) {
    console.error('[分时] 加载分时数据失败:', e)
    // [WHAT] 失败时使用空数据，会自动降级到模拟数据
    intradayData.value = []
  }
}

// ========== Canvas绘制 ==========
function drawChart() {
  const canvas = canvasRef.value
  if (!canvas) { setTimeout(drawChart, 50); return }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const data = filteredData.value
  if (data.length === 0) return
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) { setTimeout(drawChart, 50); return }
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)
  const W = rect.width
  const H = rect.height
  const chartBottom = H - 25
  const padding = { top: 15, right: 60, left: 55 }
  const chartWidth = W - padding.left - padding.right
  const colors = getThemeColors()

  // 背景
  ctx.fillStyle = colors.bgPrimary
  ctx.fillRect(0, 0, W, H)

  // 价格范围
  const prices = data.map(d => d.value)
  let minPrice = Math.min(...prices)
  let maxPrice = Math.max(...prices)
  const priceRange = (maxPrice - minPrice) * 0.1 || 0.01
  minPrice -= priceRange
  maxPrice += priceRange
  const priceSpan = maxPrice - minPrice || 1

  // 网格线
  ctx.strokeStyle = colors.gridColor
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartBottom - padding.top) * i / 4
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(W - padding.right, y)
    ctx.stroke()
  }

  // Y轴标签
  ctx.fillStyle = colors.textSecondary
  ctx.font = '10px Arial'
  ctx.textAlign = 'left'
  for (let i = 0; i <= 4; i++) {
    const price = maxPrice - priceSpan * i / 4
    const y = padding.top + (chartBottom - padding.top) * i / 4
    ctx.fillText(price.toFixed(4), W - padding.right + 5, y + 3)
  }

    // 涨跌颜色
  const upColor = colors.upColor
  const downColor = colors.downColor
  const isUp = (data[data.length - 1]?.value || 0) >= (data[0]?.value || 0)

  // [WHAT] 盘中X轴定位函数：按完整交易时间(9:30-15:00=330分钟)比例定位
  const TOTAL_TRADE_MINUTES = 330
  const TRADE_START = 570 // 9:30 = 9*60+30
  function intradayX(timeStr: string): number {
    const parts = timeStr.split(' ')
    const t = parts.length > 1 ? parts[1] : timeStr
    const tp = t.split(':')
    if (!tp || tp.length < 2) return padding.left + chartWidth
    const minutes = parseInt(tp[0]) * 60 + parseInt(tp[1])
    const ratio = Math.max(0, Math.min(1, (minutes - TRADE_START) / TOTAL_TRADE_MINUTES))
    return padding.left + chartWidth * ratio
  }

  // 绘制走势图
  if (isIntradayMode.value && data.length > 0) {
    const status = tradingStatus.value
    if (status === 'trading_realtime' || status === 'trading_closed') {
      // 实时/收盘 - 填充区域
      ctx.beginPath()
      ctx.moveTo(padding.left, chartBottom)
      data.forEach((d, i) => {
        const x = intradayX(d.time)
        const y = padding.top + (chartBottom - padding.top) * (1 - (d.value - minPrice) / priceSpan)
        ctx.lineTo(x, y)
      })
      // 填充到当前时间对应的X位置（不是chartWidth最右）
      const lastDataX = intradayX(data[data.length - 1].time)
      ctx.lineTo(lastDataX, chartBottom)
      ctx.closePath()
      const gradient = ctx.createLinearGradient(0, padding.top, 0, chartBottom)
      if (isUp) {
        gradient.addColorStop(0, 'rgba(246, 70, 93, 0.25)')
        gradient.addColorStop(0.5, 'rgba(246, 70, 93, 0.1)')
        gradient.addColorStop(1, 'rgba(246, 70, 93, 0)')
      } else {
        gradient.addColorStop(0, 'rgba(14, 203, 129, 0.25)')
        gradient.addColorStop(0.5, 'rgba(14, 203, 129, 0.1)')
        gradient.addColorStop(1, 'rgba(14, 203, 129, 0)')
      }
      ctx.fillStyle = gradient
      ctx.fill()
      // 线条
      ctx.beginPath()
      data.forEach((d, i) => {
        const x = intradayX(d.time)
        const y = padding.top + (chartBottom - padding.top) * (1 - (d.value - minPrice) / priceSpan)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.strokeStyle = isUp ? upColor : downColor
      ctx.lineWidth = 2
      ctx.stroke()
      // 末端圆点 - 在当前时间对应的位置
      const lastPoint = data[data.length - 1]
      const lastX = intradayX(lastPoint.time)
      const lastY = padding.top + (chartBottom - padding.top) * (1 - (lastPoint.value - minPrice) / priceSpan)
      const pulseRadius = 3 + Math.sin(Date.now() / 200) * 1.5
      ctx.beginPath()
      ctx.arc(lastX, lastY, pulseRadius, 0, Math.PI * 2)
      ctx.fillStyle = isUp ? upColor : downColor
      ctx.fill()
      ctx.beginPath()
      ctx.arc(lastX, lastY, pulseRadius + 3, 0, Math.PI * 2)
      ctx.strokeStyle = isUp ? upColor : downColor
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.4
      ctx.stroke()
      ctx.globalAlpha = 1
      // 标签
      ctx.fillStyle = colors.textSecondary
      ctx.font = '10px -apple-system, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(status === 'trading_realtime' ? '估算走势' : '实盘数据', padding.left + 5, padding.top + 12)
        } else {
      // 非交易时间 - 虚线（也使用 intradayX 按时间比例定位）
      ctx.beginPath()
      ctx.setLineDash([4, 4])
      data.forEach((d, i) => {
        const x = intradayX(d.time)
        const y = padding.top + (chartBottom - padding.top) * (1 - (d.value - minPrice) / priceSpan)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.strokeStyle = colors.textSecondary
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.setLineDash([])
      // 数据点
      data.forEach((d, i) => {
        const x = intradayX(d.time)
        const y = padding.top + (chartBottom - padding.top) * (1 - (d.value - minPrice) / priceSpan)
        ctx.beginPath()
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.fillStyle = colors.textSecondary
        ctx.fill()
      })
      // 未开盘标签
      ctx.fillStyle = colors.textSecondary
      ctx.font = '12px -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('未开盘', padding.left + chartWidth / 2, padding.top + 20)
    }
  } else {
    // K线图模式
    ctx.beginPath()
    ctx.moveTo(padding.left, chartBottom)
    data.forEach((d, i) => {
      const x = padding.left + chartWidth / Math.max(data.length - 1, 1) * i
      const y = padding.top + (chartBottom - padding.top) * (1 - (d.value - minPrice) / priceSpan)
      ctx.lineTo(x, y)
    })
    ctx.lineTo(padding.left + chartWidth, chartBottom)
    ctx.closePath()
    const gradient = ctx.createLinearGradient(0, padding.top, 0, chartBottom)
    if (isUp) {
      gradient.addColorStop(0, 'rgba(246, 70, 93, 0.25)')
      gradient.addColorStop(0.5, 'rgba(246, 70, 93, 0.1)')
      gradient.addColorStop(1, 'rgba(246, 70, 93, 0)')
    } else {
      gradient.addColorStop(0, 'rgba(14, 203, 129, 0.25)')
      gradient.addColorStop(0.5, 'rgba(14, 203, 129, 0.1)')
      gradient.addColorStop(1, 'rgba(14, 203, 129, 0)')
    }
    ctx.fillStyle = gradient
    ctx.fill()
    ctx.beginPath()
    data.forEach((d, i) => {
      const x = padding.left + chartWidth / Math.max(data.length - 1, 1) * i
      const y = padding.top + (chartBottom - padding.top) * (1 - (d.value - minPrice) / priceSpan)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = isUp ? upColor : downColor
    ctx.lineWidth = 2
    ctx.stroke()
    // 末端圆点
    if (data.length > 0) {
      const lastPoint = data[data.length - 1]
      const lastX = padding.left + chartWidth
      const lastY = padding.top + (chartBottom - padding.top) * (1 - (lastPoint.value - minPrice) / priceSpan)
      const pulseRadius = 3 + Math.sin(Date.now() / 200) * 1.5
      ctx.beginPath()
      ctx.arc(lastX, lastY, pulseRadius, 0, Math.PI * 2)
      ctx.fillStyle = isUp ? upColor : downColor
      ctx.fill()
      ctx.beginPath()
      ctx.arc(lastX, lastY, pulseRadius + 3, 0, Math.PI * 2)
      ctx.strokeStyle = isUp ? upColor : downColor
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.4
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  // 复权净值叠加
  if (showAccNav.value && accNavData.value.length > 0 && !isIntradayMode.value) {
    const accValues = accNavData.value.map(d => d.value)
    const accMin = Math.min(...accValues)
    const accMax = Math.max(...accValues) - accMin || 1
    ctx.beginPath()
    accNavData.value.forEach((d, i) => {
      const firstTime = new Date(data[0]?.time || '').getTime()
      const lastTime = new Date(data[data.length - 1]?.time || '').getTime()
      const dTime = new Date(d.time).getTime()
      const ratio = lastTime > firstTime ? (dTime - firstTime) / (lastTime - firstTime) : 0
      const x = padding.left + chartWidth * Math.max(0, Math.min(1, ratio))
      const y = padding.top + (chartBottom - padding.top) * (1 - (d.value - accMin) / accMax)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = '#f0b90b'
    ctx.lineWidth = 1.5
    ctx.globalAlpha = 0.7
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // 高低点标签
  if (data.length > 2) {
    const values = data.map(d => d.value)
    const highVal = Math.max(...values)
    const lowVal = Math.min(...values)
    const highIdx = values.indexOf(highVal)
    const lowIdx = values.indexOf(lowVal)
    const firstVal = data[0]?.value || 1
    const labelRects: { x: number; y: number; w: number; h: number }[] = []

        function drawLabel(val: number, idx: number, color: string, bgColor: string, text: string, position: 'top' | 'bottom') {
      if (idx < 0 || highVal === lowVal) return
      const x = isIntradayMode.value ? intradayX(data[idx].time) : padding.left + chartWidth / Math.max(data.length - 1, 1) * idx
      const y = padding.top + (chartBottom - padding.top) * (1 - (val - minPrice) / priceSpan)
      // 虚线
      ctx.beginPath()
      ctx.setLineDash([2, 2])
      ctx.moveTo(padding.left, y)
      ctx.lineTo(W - padding.right, y)
      ctx.strokeStyle = bgColor
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
      // 圆点
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      // 标签文字
      const changePct = ((val - firstVal) / firstVal * 100)
      const changeText = changePct >= 0 ? `+${changePct.toFixed(2)}%` : `${changePct.toFixed(2)}%`
      ctx.font = 'bold 9px -apple-system, sans-serif'
      const labelText = `${text} ${val.toFixed(4)} ${changeText}`
      const labelW = ctx.measureText(labelText).width + 10
      const labelH = 16
      const radius = 3
      let labelX = x + 6 + labelW < W - padding.right ? x + 6 : x - labelW - 6 > padding.left ? x - labelW - 6 : x < chartWidth / 2 ? padding.left + 2 : W - padding.right - labelW - 2
      let labelY = position === 'top' ? y - labelH - 4 : y + 4
      if (position === 'top' && labelY < padding.top) labelY = y + 4
      if (position === 'bottom' && labelY + labelH > chartBottom) labelY = y - labelH - 4
      // 防重叠
      for (const rect of labelRects) {
        if (labelX < rect.x + rect.w && labelX + labelW > rect.x && labelY < rect.y + rect.h && labelY + labelH > rect.y) {
          labelY = position === 'top' ? rect.y - labelH - 2 : rect.y + rect.h + 2
          if (labelY < padding.top) labelY = padding.top + 2
          if (labelY + labelH > chartBottom) labelY = chartBottom - labelH - 2
        }
      }
      labelRects.push({ x: labelX, y: labelY, w: labelW, h: labelH })
      // 背景
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)'
      ctx.shadowBlur = 4
      ctx.shadowOffsetX = 1
      ctx.shadowOffsetY = 1
      ctx.fillStyle = bgColor
      ctx.beginPath()
      ctx.roundRect(labelX, labelY, labelW, labelH, radius)
      ctx.fill()
      ctx.strokeStyle = bgColor.replace('0.15', '0.5')
      ctx.lineWidth = 0.5
      ctx.stroke()
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
      // 文字
      ctx.fillStyle = color
      ctx.font = 'bold 9px -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(labelText, labelX + labelW / 2, labelY + labelH / 2)
      ctx.textBaseline = 'alphabetic'
    }

    drawLabel(highVal, highIdx, '#f6465d', 'rgba(246, 70, 93, 0.15)', '最高', 'top')
    drawLabel(lowVal, lowIdx, '#0ecb81', 'rgba(14, 203, 129, 0.15)', '最低', 'bottom')
  }

    // 十字光标
  if (crosshairVisible.value && crosshairDataIdx.value >= 0) {
    const mouseX = crosshairX.value
    const d = data[crosshairDataIdx.value]
    if (d && mouseX >= padding.left && mouseX <= W - padding.right) {
      const x = isIntradayMode.value ? intradayX(d.time) : padding.left + chartWidth / Math.max(data.length - 1, 1) * crosshairDataIdx.value
      const y = padding.top + (chartBottom - padding.top) * (1 - (d.value - minPrice) / priceSpan)
      const lineColor = themeStore.actualTheme === 'dark' ? 'rgba(234, 236, 239, 0.3)' : 'rgba(26, 26, 26, 0.3)'
      const labelBg = themeStore.actualTheme === 'dark' ? '#2b3139' : '#e8e8e8'
      const labelColor = themeStore.actualTheme === 'dark' ? '#eaecef' : '#1a1a1a'
      // 垂直线
      ctx.beginPath()
      ctx.setLineDash([3, 3])
      ctx.moveTo(x, padding.top)
      ctx.lineTo(x, chartBottom)
      ctx.strokeStyle = lineColor
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
      // 水平线
      ctx.beginPath()
      ctx.setLineDash([3, 3])
      ctx.moveTo(padding.left, y)
      ctx.lineTo(W - padding.right, y)
      ctx.strokeStyle = lineColor
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
      // 数据点
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fillStyle = d.value >= (data[0]?.value || 0) ? upColor : downColor
      ctx.fill()
      ctx.beginPath()
      ctx.arc(x, y, 6, 0, Math.PI * 2)
      ctx.strokeStyle = d.value >= (data[0]?.value || 0) ? upColor : downColor
      ctx.lineWidth = 1.5
      ctx.stroke()
      // Y轴标签
      const priceText = d.value.toFixed(4)
      ctx.font = '11px -apple-system, SF Mono, monospace'
      const priceLabelW = ctx.measureText(priceText).width + 12
      const priceLabelH = 20
      const priceLabelX = W - padding.right + 2
      const priceLabelY = y - priceLabelH / 2
      ctx.fillStyle = labelBg
      ctx.beginPath()
      ctx.roundRect(priceLabelX, priceLabelY, priceLabelW, priceLabelH, 3)
      ctx.fill()
      ctx.fillStyle = labelColor
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(priceText, priceLabelX + 6, y)
      // X轴标签
      let dateText: string
      if (isIntradayMode.value) {
        const parts = d.time.split(' ')
        dateText = parts.length > 1 ? parts[1] : d.time
      } else {
        const parts = d.time.split('-')
        dateText = parts.length >= 3 ? `${parts[1]}-${parts[2]}` : d.time
      }
      ctx.font = '11px -apple-system, SF Mono, monospace'
      const dateLabelW = ctx.measureText(dateText).width + 12
      const dateLabelH = 20
      const dateLabelX = x - dateLabelW / 2
      const dateLabelY = chartBottom + 2
      ctx.fillStyle = labelBg
      ctx.beginPath()
      ctx.roundRect(dateLabelX, dateLabelY, dateLabelW, dateLabelH, 3)
      ctx.fill()
      ctx.fillStyle = labelColor
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(dateText, x, dateLabelY + dateLabelH / 2)
      // 信息框
      const firstVal = data[0]?.value || 1
      const changePct = ((d.value - firstVal) / firstVal) * 100
      let infoLines: string[]
      if (isIntradayMode.value) {
        const parts = d.time.split(' ')
        infoLines = [parts.length > 1 ? parts[1] : d.time, `净值: ${d.value.toFixed(4)}`, `涨跌: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`]
      } else {
        infoLines = [d.time, `净值: ${d.value.toFixed(4)}`, `涨跌: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`]
      }
      ctx.font = '11px -apple-system, sans-serif'
      const infoW = Math.max(...infoLines.map(l => ctx.measureText(l).width)) + 16
      const infoH = infoLines.length * 18 + 10
      let infoX = x + 12
      let infoY = Math.max(padding.top + 5, y - infoH / 2)
      if (infoX + infoW > W - 5) infoX = x - infoW - 12
      if (infoY + infoH > chartBottom - 5) infoY = chartBottom - infoH - 5
      ctx.fillStyle = themeStore.actualTheme === 'dark' ? 'rgba(30, 35, 41, 0.95)' : 'rgba(255, 255, 255, 0.95)'
      ctx.beginPath()
      ctx.roundRect(infoX, infoY, infoW, infoH, 4)
      ctx.fill()
      ctx.strokeStyle = lineColor
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = labelColor
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      infoLines.forEach((line, i) => {
        if (i === 2) ctx.fillStyle = changePct >= 0 ? upColor : downColor
        ctx.fillText(line, infoX + 8, infoY + 5 + i * 18)
      })
    }
  }

      // X轴日期标签 - 绘制在图表区域内底部，避免与十字光标标签冲突
  ctx.fillStyle = colors.textSecondary
  ctx.font = '10px Arial'
  ctx.textAlign = 'center'
  const labelCount = Math.min(5, data.length)
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.floor((data.length - 1) * i / Math.max(labelCount - 1, 1))
    const d = data[idx]
    if (!d) continue
    let label: string
    if (isIntradayMode.value) {
      const parts = d.time.split(' ')
      const datePart = parts[0] || d.time.slice(0, 10)
      if (i === 0) label = `今日 ${datePart.slice(5)}`
      else if (i === labelCount - 1) label = '15:00'
      else label = ''
    } else {
      const parts = d.time.split('-')
      label = parts.length >= 3 ? `${parts[1]}-${parts[2]}` : d.time.slice(-5)
    }
    // [WHAT] 盘中模式按时间比例定位，"15:00"固定在最右侧
    let x: number
    if (isIntradayMode.value) {
      if (i === labelCount - 1) {
        x = padding.left + chartWidth // 15:00 固定在最右侧
      } else {
        x = intradayX(d.time)
      }
    } else {
      x = padding.left + chartWidth / Math.max(data.length - 1, 1) * idx
    }
    ctx.fillText(label, x, chartBottom + 15)
  }
}

// ========== 交互 ==========
function formatVolume(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
  return v.toFixed(0)
}

function onPointerDown(e: PointerEvent) {
  crosshairVisible.value = true
  updateCrosshair(e)
}

function onPointerMove(e: PointerEvent) {
  if (crosshairVisible.value) updateCrosshair(e)
}

function onPointerUp() {
  crosshairVisible.value = false
  crosshairDataIdx.value = -1
}

function onPointerLeave() {
  crosshairVisible.value = false
  crosshairDataIdx.value = -1
}

function updateCrosshair(e: PointerEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  crosshairX.value = x
  crosshairY.value = y
  const padding = { left: 55, right: 60 }
  const chartWidth = rect.width - padding.left - padding.right
  const data = filteredData.value
  if (data.length > 0 && x >= padding.left && x <= rect.width - padding.right) {
    if (isIntradayMode.value) {
      // [WHAT] 盘中模式：根据X坐标反算时间，找到最近的数据点
      const TOTAL_TRADE_MINUTES = 330
      const TRADE_START = 570
      const ratio = (x - padding.left) / chartWidth
      const targetMinutes = TRADE_START + ratio * TOTAL_TRADE_MINUTES
      let bestIdx = 0
      let bestDist = Infinity
      data.forEach((d, i) => {
        const parts = d.time.split(' ')
        const t = parts.length > 1 ? parts[1] : d.time
        const tp = t.split(':')
        if (!tp || tp.length < 2) return
        const itemMinutes = parseInt(tp[0]) * 60 + parseInt(tp[1])
        const dist = Math.abs(itemMinutes - targetMinutes)
        if (dist < bestDist) { bestDist = dist; bestIdx = i }
      })
      crosshairDataIdx.value = bestIdx
    } else {
      const idx = Math.round((x - padding.left) / chartWidth * (data.length - 1))
      crosshairDataIdx.value = Math.max(0, Math.min(data.length - 1, idx))
    }
  }
}

// ========== 周期切换 ==========
let animFrameId: number | null = null

function switchPeriod(period: string) {
  if (period === '1d') {
    resetIntraday()
    loadIntradayData()
  }
  activePeriod.value = period
  nextTick(() => {
    drawChart()
    startAnimation()
  })
}

function startAnimation() {
  if (animFrameId) return
  let lastTime = 0
  function animate(time: number) {
    if (time - lastTime > 33) {
      lastTime = time
      drawChart()
    }
    animFrameId = requestAnimationFrame(animate)
  }
  animFrameId = requestAnimationFrame(animate)
}

function stopAnimation() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId)
    animFrameId = null
  }
}

// ========== 监听 ==========
watch(() => props.fundCode, () => {
  resetIntraday()
  loadData()
}, { immediate: true })

watch(() => props.realtimeValue, (val) => {
  if (val && val > 0) {
    const now = new Date()
    const h = now.getHours(), m = now.getMinutes()
    if (h * 60 + m > 900) return
    if (isIntradayMode.value) addRealtimePoint(val)
  }
})

watch(() => props.lastClose, (val) => {
  if (val && val > 0 && baseValue.value === 0) baseValue.value = val
})

watch(() => activePeriod.value, () => {
  nextTick(() => drawChart())
})

watch(() => themeStore.actualTheme, () => {
  nextTick(() => drawChart())
})

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (canvasRef.value) {
    resizeObserver = new ResizeObserver(() => drawChart())
    resizeObserver.observe(canvasRef.value.parentElement!)
  }
    if (props.realtimeValue > 0) addRealtimePoint(props.realtimeValue)
})

onUnmounted(() => {
  stopAnimation()
  resizeObserver?.disconnect()
})
</script>

<template>
  <div class="pro-chart">
                                                <!-- 周期选择器 -->
    <div class="period-selector">
      <div class="period-tabs">
        <div
          v-for="p in visiblePeriods"
          :key="p.key"
          :class="['period-btn', { active: activePeriod === p.key }]"
          @click.stop="switchPeriod(p.key)"
        >
          {{ p.label }}
        </div>
        
      </div>
            <div class="period-tools">
        <span :class="['tool-label', { active: tradingStatus === 'trading_realtime' }]">实时</span>
        <span :class="['live-dot', { active: tradingStatus === 'trading_realtime' }]"></span>
      </div>
    </div>

    <!-- 复权净值切换 -->
    <div class="acc-nav-bar">
      <div :class="['acc-nav-toggle', { active: showAccNav }]" @click="toggleAccNav">
        <span :class="['acc-nav-dot', { active: showAccNav }]"></span>
        <span>复权净值</span>
      </div>
      <span v-if="accNavLoading" class="acc-nav-loading">加载中...</span>
      <span v-if="showAccNav && accNavData.length > 0" class="acc-nav-info">
        {{ accNavData[accNavData.length - 1]?.value?.toFixed(4) || '--' }}
      </span>
    </div>

    <!-- OHLC数据 -->
    <div class="ohlc-bar">
      <span class="ohlc-item">
        <span class="ohlc-label">开</span>
        <span class="ohlc-value">{{ ohlcData.open.toFixed(4) }}</span>
      </span>
      <span class="ohlc-item">
        <span class="ohlc-label">高</span>
        <span class="ohlc-value up">{{ ohlcData.high.toFixed(4) }}</span>
      </span>
      <span class="ohlc-item">
        <span class="ohlc-label">低</span>
        <span class="ohlc-value down">{{ ohlcData.low.toFixed(4) }}</span>
      </span>
      <span class="ohlc-item">
        <span class="ohlc-label">收</span>
        <span :class="['ohlc-value', currentChange >= 0 ? 'up' : 'down']">
          {{ realtimeValue > 0 ? realtimeValue.toFixed(4) : ohlcData.close.toFixed(4) }}
        </span>
      </span>
      <span class="ohlc-item">
        <span class="ohlc-label">涨跌</span>
        <span :class="['ohlc-value', currentChange >= 0 ? 'up' : 'down']">
          {{ currentChange >= 0 ? '+' : '' }}{{ currentChange.toFixed(2) }}%
        </span>
      </span>
    </div>

    <!-- 交易状态 -->
    <div v-if="isIntradayMode" class="display-mode-bar">
      <span v-if="tradingStatus === 'trading_realtime'" class="mode-tag realtime">
        <span class="mode-dot"></span> 估算走势
      </span>
      <span v-else-if="tradingStatus === 'trading_closed'" class="mode-tag closed">实盘数据</span>
      <span v-else-if="tradingStatus === 'non_trading'" class="mode-tag non-trading">上个交易日实盘</span>
    </div>

    <!-- 图表容器 -->
    <div class="chart-container">
      <div v-if="isLoading" class="chart-loading">
        <van-loading size="24px" color="#0ecb81">加载中...</van-loading>
      </div>
      <canvas
        v-else
        ref="canvasRef"
        class="chart-canvas"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointerleave="onPointerLeave"
      ></canvas>
    </div>

    <!-- 成交量 -->
    <div class="volume-label">
      <span>成交量(Volume)</span>
      <span class="volume-value">{{ formatVolume(filteredData[filteredData.length - 1]?.volume || 0) }}</span>
    </div>

    <!-- 阶段涨幅 -->
    <div v-if="periodReturns.length > 0" class="returns-bar">
      <div v-for="item in periodReturns" :key="item.period" class="return-item">
        <span class="return-label">{{ item.label }}</span>
        <span :class="['return-value', item.change >= 0 ? 'up' : 'down']">
          {{ item.change >= 0 ? '+' : '' }}{{ item.change.toFixed(2) }}%
        </span>
      </div>
    </div>
        
  </div>
</template>

<style scoped>
/* ========== 专业图表样式 ========== */
.pro-chart {
  background: var(--bg-primary);
  border-radius: 12px;
  overflow: hidden;
}

/* 周期选择器 */
.period-selector {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  gap: 2px;
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  -webkit-overflow-scrolling: touch;
}

.period-selector::-webkit-scrollbar {
  display: none;
}

.period-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: nowrap;
  flex: 1;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.period-tabs::-webkit-scrollbar {
  display: none;
}

.period-btn {
  min-height: 36px;
  min-width: 44px;
  padding: 8px 14px;
  font-size: 14px;
  color: var(--text-secondary);
  background: transparent;
  border-radius: 6px;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.15s ease;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  -webkit-user-select: none;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

.period-btn:active {
  transform: scale(0.95);
  opacity: 0.8;
}

.period-btn.active {
  color: var(--color-primary);
  background: transparent;
  font-weight: 500;
  border-bottom: 2px solid var(--color-primary);
  border-radius: 0;
}

.more-btn {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 6px 10px;
}

.more-icon {
  font-size: 10px;
  margin-left: 2px;
}

.period-tools {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.expand-btn {
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}

.tool-label {
  font-size: 12px;
  color: var(--color-down);
  padding: 5px 10px;
  background: var(--color-down-bg);
  border-radius: 4px;
}

.tool-label.active {
  color: var(--color-primary);
  background: var(--color-primary-bg);
}

.live-dot {
  width: 8px;
  height: 8px;
  background: var(--color-down);
  border-radius: 50%;
  animation: pulse 1.5s infinite;
}

.live-dot.active {
  background: var(--color-primary);
  animation: pulse-green 1.5s infinite;
}

@keyframes pulse-green {
  0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 4px var(--color-primary); }
  50% { opacity: 0.7; transform: scale(1.2); box-shadow: 0 0 8px var(--color-primary); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.3); }
}

/* 复权净值 */
.acc-nav-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
}

.acc-nav-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.2s;
}

.acc-nav-toggle.active {
  color: #f0b90b;
  background: rgba(240, 185, 11, 0.1);
}

.acc-nav-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-secondary);
}

.acc-nav-dot.active {
  background: #f0b90b;
}

.acc-nav-loading {
  font-size: 11px;
  color: var(--text-secondary);
}

.acc-nav-info {
  font-size: 12px;
  color: #f0b90b;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
}

/* OHLC数据 */
.ohlc-bar {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  font-size: 13px;
  border-bottom: 1px solid var(--border-color);
}

.ohlc-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ohlc-label {
  color: var(--text-secondary);
  font-size: 11px;
}

.ohlc-value {
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  color: var(--text-primary);
}

.ohlc-value.up { color: var(--color-up); }
.ohlc-value.down { color: var(--color-down); }

/* 交易状态 */
.display-mode-bar {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
}

.mode-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
}

.mode-tag.realtime {
  color: #0ecb81;
  background: rgba(14, 203, 129, 0.1);
}

.mode-tag.closed {
  color: var(--text-secondary);
  background: var(--bg-secondary);
}

.mode-tag.non-trading {
  color: var(--text-secondary);
  background: var(--bg-secondary);
}

.mode-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #0ecb81;
  animation: pulse 1.5s infinite;
}

/* 图表容器 */
.chart-container {
  position: relative;
  height: 240px;
  background: var(--bg-primary);
}

.chart-canvas {
  width: 100%;
  height: 100%;
  touch-action: none;
}

.chart-loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

/* 成交量 */
.volume-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  border-top: 1px solid var(--border-color);
}

.volume-value {
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
  color: var(--text-primary);
}

/* 阶段涨幅 */
.returns-bar {
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  padding: 12px 8px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.return-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  min-width: 70px;
  flex: 0 0 auto;
  white-space: nowrap;
}

.return-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.return-value {
  font-size: 14px;
  font-weight: 600;
  font-family: -apple-system, 'SF Mono', 'Roboto Mono', monospace;
}

.return-value.up { color: var(--color-up); }
.return-value.down { color: var(--color-down); }

/* 响应式适配 */
@media screen and (max-width: 375px) {
  .period-btn {
    padding: 5px 8px;
    font-size: 12px;
  }
  .ohlc-bar {
    gap: 8px;
    font-size: 12px;
  }
  .chart-container {
    height: 200px;
  }
  .returns-bar {
    padding: 10px 4px;
    gap: 2px;
  }
  .return-item {
    padding: 3px 4px;
  }
  .return-label {
    font-size: 10px;
  }
  .return-value {
    font-size: 11px;
  }
}

@media screen and (min-width: 414px) {
  .period-btn {
    padding: 8px 14px;
    font-size: 14px;
  }
  .chart-container {
    height: 280px;
  }
}

@supports (padding-bottom: env(safe-area-inset-bottom)) {
  .pro-chart {
    padding-bottom: env(safe-area-inset-bottom);
  }
}
</style>
