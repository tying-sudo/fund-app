<script setup lang="ts">
defineOptions({ name: 'Home' })
// [WHY] 首页 - 展示自选基金列表和快捷入口
// [WHAT] 支持下拉刷新、左滑删除、点击跳转搜索添加、设置提醒、类型筛选

import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useFundStore } from '@/stores/fund'
import { useAlertStore, ALERT_TYPE_CONFIG, type AlertType } from '@/stores/alert'
import { 
  fetchRemoteConfig, 
  getActiveAnnouncements, 
  markAnnouncementShown,
  checkNeedUpdate,
  type Announcement,
  type RemoteConfig
} from '@/api/remote'
import { APP_VERSION } from '@/config/version'
import { showConfirmDialog, showToast, showSuccessToast, showLoadingToast, closeToast } from 'vant'
import FundCard from '@/components/FundCard.vue'
import DataSourceSelector from '@/components/DataSourceSelector.vue'
import { DATA_SOURCE_CONFIG, type DataSource } from '@/types/fund'

const router = useRouter()
const fundStore = useFundStore()
const alertStore = useAlertStore()

// ========== 类型筛选 ==========
// [WHAT] 可选的基金类型列表
const fundTypes = [
  { value: 'all', label: '全部' },
  { value: 'holding', label: '持有' },
  { value: 'QDII', label: 'QDII' },
  { value: '海外', label: '海外' },
  { value: 'LOF', label: 'LOF' },
  { value: 'ETF', label: 'ETF' },
  { value: '联接', label: '联接' },
  { value: 'FOF', label: 'FOF' },
  { value: '货币', label: '货币' },
  { value: '黄金', label: '黄金' },
  { value: '债券', label: '债券' },
  { value: '指数', label: '指数' },
  { value: '偏股', label: '偏股' }
]

// [WHAT] 当前选中的类型
const selectedType = ref('all')

// [WHAT] 类型筛选弹窗显示状态
const showTypeFilter = ref(false)

// [WHAT] 当前选中类型的标签
const currentTypeLabel = computed(() => {
  const found = fundTypes.find(t => t.value === selectedType.value)
  return found ? found.label : '全部'
})

// [WHAT] 筛选后的基金列表
const filteredWatchlist = computed(() => {
  if (selectedType.value === 'all') {
    return fundStore.watchlist
  }
  if (selectedType.value === 'holding') {
    // [TODO] 持有筛选需要结合持仓数据，暂时返回全部
    return fundStore.watchlist
  }
  // [WHAT] 根据基金类型筛选
  return fundStore.watchlist.filter(fund => {
    const type = fund.type || ''
    return type.includes(selectedType.value)
  })
})

// [WHAT] 选择类型
function selectType(type: string) {
  selectedType.value = type
  showTypeFilter.value = false
}

// [WHAT] 公告列表（默认 + 远程）
const defaultNotices = [
  '基金投资有风险，入市需谨慎',
  '交易时间：工作日 9:30-15:00'
]
const notices = ref<string[]>([...defaultNotices])

// [WHAT] 远程公告
const remoteAnnouncements = ref<Announcement[]>([])
const showAnnouncementPopup = ref(false)
const currentAnnouncement = ref<Announcement | null>(null)

// [WHAT] 更新状态
const updateInfo = ref<{
  needUpdate: boolean
  forceUpdate: boolean
  latestVersion: string
  updateUrl: string
} | null>(null)

// [WHAT] 页面挂载时初始化数据
onMounted(async () => {
  fundStore.initWatchlist()
  // 启动自动刷新
  fundStore.startAutoRefresh()
  // 请求通知权限
  await alertStore.requestNotificationPermission()
  // 加载远程配置
  loadRemoteConfig()
  // [WHAT] 点击外部关闭下拉菜单
  document.addEventListener('click', closeTypeDropdown)
})

// [WHAT] 页面卸载时停止自动刷新
onUnmounted(() => {
  fundStore.stopAutoRefresh()
  document.removeEventListener('click', closeTypeDropdown)
})

// [WHAT] 关闭类型下拉菜单
function closeTypeDropdown() {
  showTypeFilter.value = false
}

// [WHAT] 加载远程配置（公告和更新检查）
async function loadRemoteConfig() {
  try {
    const config = await fetchRemoteConfig()
    if (!config) return
    
    // 检查更新
    const { needUpdate, forceUpdate } = checkNeedUpdate(APP_VERSION, config)
    if (needUpdate) {
      updateInfo.value = {
        needUpdate,
        forceUpdate,
        latestVersion: config.version,
        updateUrl: config.updateUrl
      }
    }
    
    // 获取有效公告
    remoteAnnouncements.value = getActiveAnnouncements(config)
    
    // 将远程公告添加到滚动公告
    if (remoteAnnouncements.value.length > 0) {
      const remoteNoticeTexts = remoteAnnouncements.value.map(a => `【${a.title}】${a.content.split('\n')[0]}`)
      notices.value = [...remoteNoticeTexts, ...defaultNotices]
    }
  } catch (err) {
    console.warn('加载远程配置失败:', err)
  }
}

// [WHAT] 打开公告详情
function openAnnouncement(announcement: Announcement) {
  currentAnnouncement.value = announcement
  showAnnouncementPopup.value = true
}

// [WHAT] 关闭公告并标记已读
function closeAnnouncement() {
  if (currentAnnouncement.value) {
    markAnnouncementShown(currentAnnouncement.value.id)
    // 从列表移除
    remoteAnnouncements.value = remoteAnnouncements.value.filter(
      a => a.id !== currentAnnouncement.value?.id
    )
  }
  showAnnouncementPopup.value = false
  currentAnnouncement.value = null
}

// [WHAT] 跳转更新
function goToUpdate() {
  if (updateInfo.value?.updateUrl) {
    window.open(updateInfo.value.updateUrl, '_blank')
  }
}

// [WHAT] 监听数据变化，检查提醒条件
watch(
  () => fundStore.watchlist,
  (watchlist) => {
    for (const fund of watchlist) {
      if (fund.estimateValue && fund.estimateChange) {
        const value = parseFloat(fund.estimateValue)
        const change = parseFloat(fund.estimateChange)
        if (!isNaN(value) && !isNaN(change)) {
          alertStore.checkAlerts(fund.code, value, change)
        }
      }
    }
  },
  { deep: true }
)


// [WHAT] 删除自选基金
async function handleDelete(code: string) {
  try {
    await showConfirmDialog({
      title: '确认删除',
      message: '确定要从自选中删除该基金吗？'
    })
    fundStore.removeFund(code)
    showToast('已删除')
  } catch {
    // 用户取消
  }
}

// [WHAT] 跳转到搜索页
function goToSearch() {
  router.push('/search')
}

// [WHAT] 跳转到基金详情页
function goToDetail(code: string) {
  router.push(`/detail/${code}`)
}

// ========== 提醒设置弹窗 ==========
const showAlertDialog = ref(false)
const alertFund = ref<{ code: string; name: string } | null>(null)
const alertForm = ref({
  type: 'change_up' as AlertType,
  threshold: ''
})

const alertTypes = Object.entries(ALERT_TYPE_CONFIG).map(([key, config]) => ({
  value: key,
  label: config.label
}))

// [WHAT] 长按打开提醒设置
function onFundLongPress(code: string, name: string) {
  alertFund.value = { code, name }
  alertForm.value = { type: 'change_up', threshold: '' }
  showAlertDialog.value = true
}

// [WHAT] 提交提醒设置
function submitAlert() {
  if (!alertFund.value) return
  const threshold = parseFloat(alertForm.value.threshold)
  if (isNaN(threshold) || threshold <= 0) {
    showToast('请输入有效的阈值')
    return
  }

  alertStore.addAlert({
    code: alertFund.value.code,
    name: alertFund.value.name,
    type: alertForm.value.type,
    threshold,
    enabled: true
  })
  
  showToast('提醒已设置')
  showAlertDialog.value = false
}

// ========== 数据源选择器（新增） ==========
const showDataSourceSelector = ref(false)
const dataSourceTargetCode = ref('')
const dataSourceTargetName = ref('')

/** 处理数据源切换事件 */
function onSourceSelect(code: string) {
  const fund = fundStore.watchlist.find(f => f.code === code)
  dataSourceTargetCode.value = code
  dataSourceTargetName.value = fund?.name || code
  showDataSourceSelector.value = true
}

/** 处理数据源选择完成 */
async function onDataSourceSelected(source: DataSource) {
  const code = dataSourceTargetCode.value
  console.log(`[数据源] ${code} 切换至 ${source}`)
  
  // [FIX] 显示加载状态
  showLoadingToast({
    message: `正在切换至${DATA_SOURCE_CONFIG[source]?.name}...`,
    forbidClick: true,
    duration: 0
  })
  
  try {
    // [WHAT] setFundDataSource 内部已经调用了 refreshSingleFundWithSource
    // 不需要再单独调用 refreshSingleFund
    await fundStore.setFundDataSource(code, source)
    
    closeToast()
    showSuccessToast(`已切换至${DATA_SOURCE_CONFIG[source]?.name}`)
    console.log(`[数据源] ${code} 切换完成`)
  } catch (err) {
    closeToast()
    console.error(`[数据源] ${code} 切换失败:`, err)
    showToast('切换失败，请重试')
  }
}

/** 手动立即刷新 */
const isManualRefreshing = ref(false)
/** 仅用于 van-pull-refresh 下拉动画（与自动刷新解耦） */
const isPullRefreshing = ref(false)
async function onManualRefresh() {
  if (isManualRefreshing.value) return
  
  isManualRefreshing.value = true
  try {
    await fundStore.refreshEstimates()
    showToast('刷新完成')
  } finally {
    isManualRefreshing.value = false
  }
}

/** 手动下拉刷新 */
async function onRefresh() {
  isPullRefreshing.value = true
  try {
    await fundStore.refreshEstimates()
  } finally {
    isPullRefreshing.value = false
  }
}
</script>

<template>
  <div class="home-page">
    <!-- 顶部搜索栏 -->
    <div class="top-header">
      <div class="header-left">
        <span class="app-title">基金宝</span>
      </div>
      <div class="search-bar" @click="goToSearch">
        <van-icon name="search" size="16" />
        <span>搜索基金代码/名称</span>
      </div>
      <div class="header-right">
        <!-- 立即刷新按钮 -->
        <div class="refresh-btn" @click="onManualRefresh" :class="{ refreshing: fundStore.isRefreshing }">
          <van-icon name="replay" size="18" :class="{ spinning: isManualRefreshing }" />
          <span class="refresh-label">立即刷新</span>
        </div>
        <van-icon name="setting-o" size="22" @click="router.push('/alerts')" />
      </div>
    </div>
    
    <!-- 公告栏 -->
    <div class="notice-bar">
      <van-icon name="volume-o" class="notice-icon" />
      <van-swipe 
        class="notice-swipe" 
        vertical 
        :autoplay="3000" 
        :show-indicators="false"
        :touchable="false"
      >
        <van-swipe-item v-for="(notice, idx) in notices" :key="idx">
          {{ notice }}
        </van-swipe-item>
      </van-swipe>
    </div>
    
    <!-- 强制更新遮罩 -->
    <van-overlay :show="updateInfo?.forceUpdate" z-index="9999" class="force-update-overlay">
      <div class="force-update-content">
        <van-icon name="info-o" size="48" color="#ee0a24" />
        <h3>发现新版本 v{{ updateInfo?.latestVersion }}</h3>
        <p>当前版本过低，请更新后继续使用</p>
        <van-button type="danger" block @click="goToUpdate">
          立即更新
        </van-button>
      </div>
    </van-overlay>
    
    <!-- 更新提示卡片（普通更新） -->
    <div v-if="updateInfo?.needUpdate && !updateInfo?.forceUpdate" class="update-card">
      <div class="update-info">
        <van-icon name="upgrade" size="20" color="#1989fa" />
        <span>发现新版本 v{{ updateInfo.latestVersion }}</span>
      </div>
      <van-button size="small" type="primary" plain @click="goToUpdate">
        立即更新
      </van-button>
      <van-icon name="cross" class="close-btn" @click="updateInfo = null" />
    </div>
    
        <!-- 远程公告卡片 -->
    <div v-if="remoteAnnouncements.length > 0" class="announcement-cards">
      <div 
        v-for="announcement in remoteAnnouncements" 
        :key="announcement.id"
        class="announcement-card"
        :class="announcement.type"
        @click="openAnnouncement(announcement)"
      >
        <van-icon 
          :name="announcement.type === 'update' ? 'upgrade' : announcement.type === 'warning' ? 'warning-o' : 'info-o'" 
          size="18"
        />
        <span class="announcement-title">{{ announcement.title }}</span>
        <van-icon name="arrow" size="14" />
      </div>
    </div>


                                                <!-- 下拉刷新列表 -->
    <van-pull-refresh 
      v-model="isPullRefreshing" 
      @refresh="onRefresh"
      class="fund-list-container"
    >
                  <!-- 自选基金标题 -->
      <div class="section-header" v-if="fundStore.watchlist.length > 0">
        <span class="section-title">自选基金</span>
        <div class="header-right">
          <span class="fund-count">{{ fundStore.watchlist.length }}只</span>
          <div class="type-filter-dropdown" @click.stop="showTypeFilter = !showTypeFilter">
            <span class="type-filter-label">排序: {{ currentTypeLabel }}</span>
            <van-icon name="arrow-down" size="12" />
            <!-- 下拉菜单 -->
            <div v-if="showTypeFilter" class="type-dropdown-menu">
              <div 
                v-for="type in fundTypes" 
                :key="type.value"
                class="type-dropdown-item"
                :class="{ active: selectedType === type.value }"
                @click.stop="selectType(type.value)"
              >
                {{ type.label }}
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 有自选基金时显示列表 -->
      <template v-if="fundStore.watchlist.length > 0">
        <!-- 刷新时间提示 -->
        <div v-if="fundStore.lastRefreshTime" class="refresh-time">
          <span>最后刷新: {{ fundStore.lastRefreshTime }}</span>
          <span v-if="alertStore.enabledAlerts.length > 0" class="alert-badge">
            {{ alertStore.enabledAlerts.length }}个提醒
          </span>
        </div>
        
        <!-- 基金列表 -->
        <FundCard
          v-for="fund in filteredWatchlist"
          :key="fund.code"
          :fund="fund"
          @delete="handleDelete"
          @click="goToDetail"
          @longpress="onFundLongPress(fund.code, fund.name)"
          @sourceSelect="onSourceSelect"
        />
      </template>

      <!-- 空状态 -->
      <van-empty
        v-else
        image="search"
        description="暂无自选基金"
      >
        <van-button round type="primary" @click="goToSearch">
          添加基金
        </van-button>
      </van-empty>
      
      <!-- 底部占位 -->
      <div class="bottom-spacer"></div>
    </van-pull-refresh>

    <!-- 提醒设置弹窗 -->
    <van-popup v-model:show="showAlertDialog" position="bottom" round>
      <div class="alert-dialog">
        <div class="dialog-header">
          <span>设置提醒</span>
          <van-icon name="cross" @click="showAlertDialog = false" />
        </div>
        <div class="dialog-fund">{{ alertFund?.name }}</div>
        
        <van-field label="提醒类型">
          <template #input>
            <van-radio-group v-model="alertForm.type" direction="horizontal">
              <van-radio v-for="t in alertTypes" :key="t.value" :name="t.value">
                {{ t.label }}
              </van-radio>
            </van-radio-group>
          </template>
        </van-field>
        
        <van-field
          v-model="alertForm.threshold"
          :label="alertForm.type.includes('change') ? '阈值(%)' : '目标净值'"
          type="number"
          :placeholder="alertForm.type.includes('change') ? '例如: 3' : '例如: 1.5000'"
        />
        
        <div class="dialog-footer">
          <van-button block type="primary" @click="submitAlert">确认设置</van-button>
        </div>
      </div>
    </van-popup>
    
    <!-- 公告详情弹窗 -->
    <van-popup
      v-model:show="showAnnouncementPopup"
      round
      position="center"
      :style="{ width: '85%', maxWidth: '400px' }"
    >
      <div class="announcement-detail" v-if="currentAnnouncement">
        <div class="announcement-detail-header" :class="currentAnnouncement.type">
          <van-icon 
            :name="currentAnnouncement.type === 'update' ? 'upgrade' : currentAnnouncement.type === 'warning' ? 'warning-o' : 'info-o'" 
            size="24"
          />
          <h3>{{ currentAnnouncement.title }}</h3>
        </div>
        <div class="announcement-detail-content">
          <p v-for="(line, idx) in currentAnnouncement.content.split('\n')" :key="idx">
            {{ line }}
          </p>
        </div>
        <div class="announcement-detail-footer">
          <van-button 
            v-if="currentAnnouncement.type === 'update'" 
            block 
            type="primary" 
            @click="goToUpdate(); closeAnnouncement()"
          >
            立即更新
          </van-button>
          <van-button block plain @click="closeAnnouncement">
            {{ currentAnnouncement.type === 'update' ? '稍后再说' : '知道了' }}
          </van-button>
        </div>
      </div>
    </van-popup>

    <!-- 数据源选择器弹窗（新增） -->
    <DataSourceSelector
      v-model:show="showDataSourceSelector"
      :fundCode="dataSourceTargetCode"
      :fundName="dataSourceTargetName"
      @select="onDataSourceSelected"
    />
  </div>
</template>

<style scoped>
.home-page {
  min-height: 100vh;
  background: var(--bg-primary);
  transition: background-color 0.3s;
}

/* 顶部搜索栏 */
.top-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  padding-top: calc(12px + env(safe-area-inset-top, 0px));
  background: var(--bg-secondary);
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-left {
  flex-shrink: 0;
}

.app-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-primary);
}

.search-bar {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-primary);
  border-radius: 20px;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
}

.header-right {
  flex-shrink: 0;
  color: var(--text-primary);
}

/* 公告栏 */
.notice-bar {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  background: var(--bg-secondary);
  font-size: 13px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}

.notice-icon {
  color: var(--text-secondary);
  margin-right: 8px;
  flex-shrink: 0;
}

.notice-swipe {
  flex: 1;
  height: 20px;
  line-height: 20px;
}

.fund-list-container {
  /* [WHY] 固定高度才能让滚动和下拉刷新正常工作 */
  /* 减去顶部搜索栏、公告栏、底部TabBar的高度 */
  height: calc(100vh - 180px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  /* [WHY] 下拉刷新需要这个属性 */
  overscroll-behavior-y: contain;
}

/* 自选基金标题 */
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px 8px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.fund-count {
  font-size: 12px;
  color: var(--text-secondary);
}

/* 底部占位 */
.bottom-spacer {
  height: calc(60px + env(safe-area-inset-bottom, 0px));
}

.refresh-time {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 8px 0;
  background: var(--bg-primary);
}

.alert-badge {
  padding: 2px 8px;
  background: var(--color-primary);
  color: #fff;
  border-radius: 10px;
  font-size: 10px;
}

/* 提醒设置弹窗 */
.alert-dialog {
  padding: 16px;
  background: var(--bg-secondary);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 16px;
  font-weight: 500;
  margin-bottom: 12px;
  color: var(--text-primary);
}

.dialog-fund {
  font-size: 14px;
  color: var(--text-secondary);
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 12px;
}

.dialog-footer {
  padding-top: 16px;
}

/* ========== 更新提示 ========== */
.force-update-overlay {
  display: flex;
  align-items: center;
  justify-content: center;
}

.force-update-content {
  background: var(--bg-card);
  padding: 32px 24px;
  border-radius: 16px;
  text-align: center;
  width: 80%;
  max-width: 320px;
}

.force-update-content h3 {
  margin: 16px 0 8px;
  font-size: 18px;
  color: var(--text-primary);
}

.force-update-content p {
  margin: 0 0 24px;
  font-size: 14px;
  color: var(--text-secondary);
}

.update-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 12px;
  padding: 12px 16px;
  padding-top: calc(12px + env(safe-area-inset-top, 0px));
  background: linear-gradient(135deg, rgba(25, 137, 250, 0.1), rgba(25, 137, 250, 0.05));
  border: 1px solid rgba(25, 137, 250, 0.2);
  border-radius: 12px;
  position: relative;
}

.update-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-primary);
}

.update-card .close-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
}

/* ========== 公告卡片 ========== */
.announcement-cards {
  padding: 8px 12px 0;
}

.announcement-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  padding-top: calc(12px + env(safe-area-inset-top, 0px));
  margin-bottom: 8px;
  background: var(--bg-card);
  border-radius: 10px;
  cursor: pointer;
  transition: transform 0.2s;
}

.announcement-card:active {
  transform: scale(0.98);
}

.announcement-card.info {
  border-left: 3px solid #1989fa;
}

.announcement-card.info .van-icon {
  color: #1989fa;
}

.announcement-card.warning {
  border-left: 3px solid #ff976a;
}

.announcement-card.warning .van-icon {
  color: #ff976a;
}

.announcement-card.update {
  border-left: 3px solid #07c160;
}

.announcement-card.update .van-icon {
  color: #07c160;
}

.announcement-title {
  flex: 1;
  font-size: 14px;
  color: var(--text-primary);
}

.announcement-card .van-icon:last-child {
  color: var(--text-secondary);
}

/* ========== 公告详情弹窗 ========== */
.announcement-detail {
  background: var(--bg-card);
}

.announcement-detail-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px;
  border-bottom: 1px solid var(--border-color);
}

.announcement-detail-header.info {
  color: #1989fa;
}

.announcement-detail-header.warning {
  color: #ff976a;
}

.announcement-detail-header.update {
  color: #07c160;
}

.announcement-detail-header h3 {
  flex: 1;
  margin: 0;
  font-size: 17px;
  color: var(--text-primary);
}

.announcement-detail-content {
  padding: 20px;
  max-height: 300px;
  overflow-y: auto;
}

.announcement-detail-content p {
  margin: 0 0 8px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--text-primary);
}

.announcement-detail-content p:last-child {
  margin-bottom: 0;
}

.announcement-detail-footer {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ========== 类型筛选下拉菜单 ========== */
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 立即刷新按钮 */
.refresh-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: all 0.25s ease;
  min-width: 64px;
}

.refresh-btn:active {
  transform: scale(0.94);
}

.refresh-btn.refreshing {
  border-color: #1989fa;
  box-shadow: 0 0 8px rgba(25, 137, 250, 0.3);
}

.refresh-btn .refresh-label {
  font-size: 10px;
  color: var(--text-secondary);
  line-height: 1;
  white-space: nowrap;
}

.refresh-btn .van-icon.spinning {
  animation: spinRefresh 0.6s linear infinite;
  color: #1989fa;
}

@keyframes spinRefresh {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.type-filter-dropdown {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: var(--bg-card);
  border-radius: 16px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.type-filter-dropdown:active {
  background: var(--bg-secondary);
}

.type-filter-label {
  white-space: nowrap;
}

.type-dropdown-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 120px;
  background: var(--bg-card);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  overflow: hidden;
}

.type-dropdown-item {
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.2s;
}

.type-dropdown-item:active {
  background: var(--bg-secondary);
}

.type-dropdown-item.active {
  color: var(--color-primary);
  font-weight: 500;
}
</style>
