<script setup lang="ts">
// [WHY] 基金经理排行榜 - 发现优秀经理
// [WHAT] 按回报、从业年限等维度排序展示经理

import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { fetchManagerRank, type ManagerRankItem } from '@/api/tiantianApi'
import { showToast } from 'vant'

const router = useRouter()

// ========== 数据状态 ==========
const managers = ref<ManagerRankItem[]>([])
const loading = ref(true)
const isRefreshing = ref(false)

// ========== 排序选项 ==========
const sortOptions = [
  { key: 'penavgrowth', label: '平均回报' },
  { key: 'workyear', label: '管理基金数' }
]
const activeSortKey = ref('penavgrowth')

// [WHAT] 加载经理列表
async function loadManagers() {
  loading.value = true
  try {
    managers.value = await fetchManagerRank({
      sortBy: activeSortKey.value,
      pageSize: 50
    })
  } catch {
    showToast('加载失败')
  } finally {
    loading.value = false
    isRefreshing.value = false
  }
}

// [WHAT] 切换排序
function switchSort(key: string) {
  if (activeSortKey.value === key) return
  activeSortKey.value = key
  loadManagers()
}

// [WHAT] 下拉刷新
async function onRefresh() {
  isRefreshing.value = true
  await loadManagers()
}

// [WHAT] 跳转到经理详情（需要基金代码，暂时跳到搜索）
function goToManager(manager: ManagerRankItem) {
  // [EDGE] 经理排行 API 不返回基金代码，暂跳转到搜索页
  showToast(`${manager.name} - ${manager.company}`)
}

// [WHAT] 格式化收益率
function formatReturn(val: number): string {
  const sign = val >= 0 ? '+' : ''
  return `${sign}${val.toFixed(2)}%`
}

// [WHAT] 返回收益率样式类
function getReturnClass(val: number): string {
  return val >= 0 ? 'up' : 'down'
}

onMounted(loadManagers)
</script>

<template>
  <div class="manager-rank-page">
    <!-- 导航栏 -->
    <van-nav-bar 
      title="经理排行榜" 
      left-arrow 
      @click-left="router.back()"
    >
      <template #right>
        <van-icon name="replay" size="18" @click="onRefresh" />
      </template>
    </van-nav-bar>
    
    <!-- 排序选项 -->
    <div class="sort-tabs">
      <span 
        v-for="opt in sortOptions" 
        :key="opt.key"
        class="sort-tab"
        :class="{ active: activeSortKey === opt.key }"
        @click="switchSort(opt.key)"
      >
        {{ opt.label }}
      </span>
    </div>
    
    <!-- 经理列表 -->
    <van-pull-refresh v-model="isRefreshing" @refresh="onRefresh" class="manager-content">
      <div v-if="loading" class="loading-container">
        <van-loading size="36px" color="var(--color-primary)">加载中...</van-loading>
      </div>
      
      <div v-else-if="managers.length === 0" class="empty-container">
        <van-empty description="暂无数据" />
      </div>
      
      <div v-else class="manager-list">
        <div 
          v-for="(manager, index) in managers" 
          :key="manager.managerId"
          class="manager-item"
          @click="goToManager(manager)"
        >
          <!-- 排名 -->
          <div class="rank-badge" :class="{ top3: index < 3 }">
            {{ index + 1 }}
          </div>
          
          <!-- 经理信息 -->
          <div class="manager-info">
            <div class="manager-name">{{ manager.name }}</div>
            <div class="manager-company">{{ manager.company }}</div>
            <div class="manager-meta">
              <span>管理 {{ manager.fundCount }} 只基金</span>
            </div>
          </div>
          
          <!-- 收益数据 -->
          <div class="return-section">
            <div class="return-item">
              <span class="return-label">平均年化</span>
              <span class="return-value" :class="getReturnClass(manager.avgReturn)">
                {{ formatReturn(manager.avgReturn) }}
              </span>
            </div>
            <div class="return-item">
              <span class="return-label">最佳回报</span>
              <span class="return-value" :class="getReturnClass(manager.bestReturn)">
                {{ formatReturn(manager.bestReturn) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </van-pull-refresh>
  </div>
</template>

<style scoped>
.manager-rank-page {
  min-height: 100vh;
  background: var(--bg-primary);
  padding-bottom: env(safe-area-inset-bottom);
}

/* 排序选项 */
.sort-tabs {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.sort-tab {
  padding: 6px 16px;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 16px;
  cursor: pointer;
  transition: all 0.2s;
}

.sort-tab.active {
  color: #fff;
  background: var(--color-primary);
}

/* 内容区域 */
.manager-content {
  height: calc(100vh - 94px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}

.loading-container,
.empty-container {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 60px 0;
}

/* 经理列表 */
.manager-list {
  padding: 8px 0;
}

.manager-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  background: var(--bg-secondary);
  margin-bottom: 1px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.manager-item:active {
  background: var(--bg-tertiary);
}

/* 排名徽章 */
.rank-badge {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 6px;
  flex-shrink: 0;
}

.rank-badge.top3 {
  color: #fff;
  background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%);
}

/* 经理信息 */
.manager-info {
  flex: 1;
  min-width: 0;
}

.manager-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.manager-company {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.manager-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
}

/* 收益数据 */
.return-section {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

.return-item {
  text-align: right;
}

.return-label {
  font-size: 11px;
  color: var(--text-muted);
  margin-right: 4px;
}

.return-value {
  font-size: 14px;
  font-weight: 600;
  font-family: 'DIN Alternate', 'Roboto Mono', monospace;
}

.return-value.up { color: var(--color-up); }
.return-value.down { color: var(--color-down); }

/* 移动端适配 */
@media (max-width: 360px) {
  .manager-item {
    padding: 12px;
  }
  
  .manager-meta {
    font-size: 10px;
  }
  
  .return-value {
    font-size: 13px;
  }
}
</style>
