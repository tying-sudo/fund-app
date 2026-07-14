<script setup lang="ts">
// [WHY] 阶段涨幅统计组件，模仿交易所的24h/7d/30d统计
// [WHAT] 显示多时间维度的涨跌幅、排名、与指数对比

import { computed } from 'vue'
import { formatPercent, getChangeStatus } from '@/utils/format'
import type { PeriodChangeData } from '@/api/fund'

const props = defineProps<{
  data: PeriodChangeData[]
  loading?: boolean
}>()

// [WHAT] 核心周期（类似交易所的24h/7d/30d）
// [WHY] 按固定顺序排列，确保显示一致性
const corePeriods = computed(() => {
  const order = ['Z', 'Y', '3Y', '6Y', '1N']
  const periodMap = new Map(props.data.map(d => [d.period, d]))
  return order.map(key => periodMap.get(key)).filter(Boolean) as PeriodChangeData[]
})

// [WHAT] 格式化排名
function formatRank(rank: number, total: number): string {
  if (rank <= 0 || total <= 0) return '--'
  const percentile = Math.round((rank / total) * 100)
  return `${rank}/${total} (前${percentile}%)`
}
</script>

<template>
  <div class="period-stats">
    <!-- 标题栏 -->
    <div class="stats-header">
      <span class="header-title">阶段涨幅</span>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="stats-loading">
      <van-loading size="20px" />
    </div>

    <!-- 统计网格（模仿交易所简洁风格） -->
    <div v-else-if="corePeriods.length > 0" class="stats-grid">
      <div v-for="item in corePeriods" :key="item.period" class="grid-item">
        <span class="grid-label">{{ item.label }}</span>
        <span class="grid-value" :class="getChangeStatus(item.change)">
          {{ formatPercent(item.change) }}
        </span>
        <span v-if="item.rank > 0" class="grid-rank">
          {{ item.rank }}/{{ item.total }}
        </span>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="stats-empty">
      暂无数据
    </div>
  </div>
</template>

<style scoped>
.period-stats {
  background: var(--bg-secondary);
  padding: 16px;
  transition: background-color 0.3s;
}

.stats-header {
  margin-bottom: 12px;
}

.header-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}

.stats-loading,
.stats-empty {
  padding: 30px 0;
  text-align: center;
  color: var(--text-secondary);
  font-size: 14px;
}

/* 交易所风格网格布局 */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
}

.grid-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 4px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.grid-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.grid-value {
  font-size: 16px;
  font-weight: 600;
  font-family: 'DIN Alternate', 'Roboto Mono', monospace;
}

.grid-value.up { color: var(--color-up); }
.grid-value.down { color: var(--color-down); }
.grid-value.flat { color: var(--text-secondary); }

.grid-rank {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* 移动端适配 */
@media (max-width: 400px) {
  .stats-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
