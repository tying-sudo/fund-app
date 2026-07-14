<script setup lang="ts">
// [WHY] 实时行情Ticker组件，模仿欧易/币安的价格显示效果
// [WHAT] 价格变化时带闪烁动画，显示精确到秒的更新时间

import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { formatPercent, getChangeStatus } from '@/utils/format'

const props = defineProps<{
  value: string | number       // 当前估值
  change: string | number      // 涨跌幅
  lastValue: string | number   // 昨日净值
  updateTime?: string          // 更新时间
  precision?: number           // 小数位数
}>()

// [WHAT] 价格闪烁状态
const flashClass = ref('')
const prevValue = ref(0)
const displayValue = ref('--')
const displayChange = ref('--')

// [WHAT] 实时更新时间（精确到秒）
const liveTime = ref('')
let timeInterval: ReturnType<typeof setInterval> | null = null

// [WHAT] 涨跌状态
const changeStatus = computed(() => {
  const change = parseFloat(String(props.change)) || 0
  return getChangeStatus(change)
})

// [WHAT] 涨跌额
const changeAmount = computed(() => {
  const current = parseFloat(String(props.value)) || 0
  const last = parseFloat(String(props.lastValue)) || 0
  if (current === 0 || last === 0) return 0
  return current - last
})

// [WHAT] 监听价格变化，触发闪烁动画
watch(() => props.value, (newVal, oldVal) => {
  const newNum = parseFloat(String(newVal)) || 0
  const oldNum = parseFloat(String(oldVal)) || 0
  
  if (newNum !== oldNum && oldNum !== 0) {
    // [WHAT] 根据涨跌触发不同颜色的闪烁
    flashClass.value = newNum > oldNum ? 'flash-up' : 'flash-down'
    setTimeout(() => {
      flashClass.value = ''
    }, 500)
  }
  
  prevValue.value = oldNum
  updateDisplay()
}, { immediate: true })

watch(() => props.change, () => {
  updateDisplay()
}, { immediate: true })

// [WHAT] 更新显示值
function updateDisplay() {
  const precision = props.precision ?? 4
  const val = parseFloat(String(props.value)) || 0
  displayValue.value = val > 0 ? val.toFixed(precision) : '--'
  
  const change = parseFloat(String(props.change)) || 0
  displayChange.value = formatPercent(change)
}

// [WHAT] 更新实时时间
function updateLiveTime() {
  const now = new Date()
  liveTime.value = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
}

onMounted(() => {
  updateLiveTime()
  timeInterval = setInterval(updateLiveTime, 1000)
})

onUnmounted(() => {
  if (timeInterval) {
    clearInterval(timeInterval)
  }
})
</script>

<template>
  <div class="realtime-ticker" :class="changeStatus">
    <!-- 主价格显示 -->
    <div class="ticker-price" :class="[changeStatus, flashClass]">
      {{ displayValue }}
    </div>
    
    <!-- 涨跌信息行 -->
    <div class="ticker-info">
      <span class="change-amount" :class="changeStatus">
        {{ changeAmount >= 0 ? '+' : '' }}{{ changeAmount.toFixed(4) }}
      </span>
      <span class="change-rate" :class="changeStatus">
        {{ displayChange }}
      </span>
    </div>
    
    <!-- 更新时间 -->
    <div class="ticker-time">
      <span class="live-dot"></span>
      <span>实时 {{ liveTime }}</span>
    </div>
  </div>
</template>

<style scoped>
.realtime-ticker {
  /* 容器样式 */
}

/* 主价格 */
.ticker-price {
  font-size: 36px;
  font-weight: 700;
  font-family: 'DIN Alternate', 'Roboto Mono', monospace;
  line-height: 1.2;
  transition: color 0.2s;
}

.ticker-price.up { color: #e4393c; }
.ticker-price.down { color: #1db82c; }
.ticker-price.flat { color: #999; }

/* 闪烁动画 */
.ticker-price.flash-up {
  animation: flash-up 0.5s ease;
}

.ticker-price.flash-down {
  animation: flash-down 0.5s ease;
}

@keyframes flash-up {
  0% { background: rgba(228, 57, 60, 0); }
  50% { background: rgba(228, 57, 60, 0.3); }
  100% { background: rgba(228, 57, 60, 0); }
}

@keyframes flash-down {
  0% { background: rgba(29, 184, 44, 0); }
  50% { background: rgba(29, 184, 44, 0.3); }
  100% { background: rgba(29, 184, 44, 0); }
}

/* 涨跌信息 */
.ticker-info {
  display: flex;
  gap: 12px;
  margin-top: 8px;
  font-size: 16px;
  font-family: 'DIN Alternate', 'Roboto Mono', monospace;
}

.change-amount.up, .change-rate.up { color: #e4393c; }
.change-amount.down, .change-rate.down { color: #1db82c; }
.change-amount.flat, .change-rate.flat { color: #999; }

/* 更新时间 */
.ticker-time {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
  color: #999;
}

.live-dot {
  width: 6px;
  height: 6px;
  background: #1db82c;
  border-radius: 50%;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
