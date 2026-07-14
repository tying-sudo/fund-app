<script setup lang="ts">
// [WHY] 智能提醒管理页面 - 集中管理所有提醒规则
// [WHAT] 支持查看、编辑、删除、重置提醒，展示触发历史

import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAlertStore, ALERT_TYPE_CONFIG, type AlertType, type AlertRule } from '@/stores/alert'
import { useFundStore } from '@/stores/fund'
import { showConfirmDialog, showToast } from 'vant'

const router = useRouter()
const alertStore = useAlertStore()
const fundStore = useFundStore()

// 当前选中的 tab
const activeTab = ref<'active' | 'triggered' | 'all'>('active')

// 添加提醒弹窗
const showAddDialog = ref(false)
const addForm = ref({
  code: '',
  name: '',
  type: 'change_up' as AlertType,
  threshold: ''
})

// 基金选择弹窗
const showFundPicker = ref(false)

// 提醒类型选项
const alertTypes = Object.entries(ALERT_TYPE_CONFIG).map(([key, config]) => ({
  value: key as AlertType,
  label: config.label,
  unit: config.unit
}))

// [WHAT] 根据 tab 筛选提醒列表
const filteredAlerts = computed(() => {
  switch (activeTab.value) {
    case 'active':
      return alertStore.alerts.filter(a => a.enabled && !a.triggered)
    case 'triggered':
      return alertStore.alerts.filter(a => a.triggered)
    case 'all':
    default:
      return alertStore.alerts
  }
})

// [WHAT] 获取提醒类型的显示文本
function getTypeLabel(type: AlertType): string {
  return ALERT_TYPE_CONFIG[type].label
}

// [WHAT] 获取阈值显示文本
function getThresholdText(alert: AlertRule): string {
  const config = ALERT_TYPE_CONFIG[alert.type]
  return `${alert.threshold}${config.unit}`
}

// [WHAT] 选择基金
function selectFund(item: { code: string; name: string }) {
  addForm.value.code = item.code
  addForm.value.name = item.name
  showFundPicker.value = false
}

// [WHAT] 提交添加提醒
function submitAdd() {
  if (!addForm.value.code) {
    showToast('请选择基金')
    return
  }
  
  const threshold = parseFloat(addForm.value.threshold)
  if (isNaN(threshold) || threshold <= 0) {
    showToast('请输入有效的阈值')
    return
  }
  
  alertStore.addAlert({
    code: addForm.value.code,
    name: addForm.value.name,
    type: addForm.value.type,
    threshold,
    enabled: true
  })
  
  showToast('添加成功')
  showAddDialog.value = false
  
  // 重置表单
  addForm.value = {
    code: '',
    name: '',
    type: 'change_up',
    threshold: ''
  }
}

// [WHAT] 删除提醒
async function deleteAlert(alert: AlertRule) {
  try {
    await showConfirmDialog({
      title: '删除提醒',
      message: `确定删除「${alert.name}」的提醒规则？`
    })
    alertStore.deleteAlert(alert.id)
    showToast('已删除')
  } catch {
    // 用户取消
  }
}

// [WHAT] 切换提醒状态
function toggleAlert(alert: AlertRule) {
  alertStore.toggleAlert(alert.id)
  showToast(alert.enabled ? '已关闭' : '已开启')
}

// [WHAT] 重置已触发的提醒
async function resetTriggered() {
  const triggeredCount = alertStore.alerts.filter(a => a.triggered).length
  if (triggeredCount === 0) {
    showToast('暂无已触发的提醒')
    return
  }
  
  try {
    await showConfirmDialog({
      title: '重置提醒',
      message: `确定重置 ${triggeredCount} 条已触发的提醒？重置后可以再次触发。`
    })
    alertStore.resetTriggeredAlerts()
    showToast('已重置')
  } catch {
    // 用户取消
  }
}

// [WHAT] 清空所有提醒
async function clearAll() {
  if (alertStore.alerts.length === 0) {
    showToast('暂无提醒规则')
    return
  }
  
  try {
    await showConfirmDialog({
      title: '清空提醒',
      message: '确定清空所有提醒规则？此操作不可恢复。',
      confirmButtonColor: '#ee0a24'
    })
    alertStore.clearAllAlerts()
    showToast('已清空')
  } catch {
    // 用户取消
  }
}

// [WHAT] 获取提醒状态标签
function getStatusTag(alert: AlertRule): { text: string; type: 'success' | 'warning' | 'default' } {
  if (alert.triggered) {
    return { text: '已触发', type: 'warning' }
  }
  if (alert.enabled) {
    return { text: '监控中', type: 'success' }
  }
  return { text: '已关闭', type: 'default' }
}

// [WHAT] 格式化时间
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
}

// 自选基金列表
const watchlistOptions = computed(() => {
  return fundStore.watchlist.map(f => ({
    code: f.code,
    name: f.name || f.code
  }))
})
</script>

<template>
  <div class="alerts-page">
    <!-- 导航栏 -->
    <van-nav-bar 
      title="智能提醒" 
      left-arrow 
      @click-left="router.back()"
    >
      <template #right>
        <van-icon name="plus" size="20" @click="showAddDialog = true" />
      </template>
    </van-nav-bar>
    
    <!-- Tab 切换 -->
    <div class="tab-bar">
      <span 
        class="tab-item" 
        :class="{ active: activeTab === 'active' }"
        @click="activeTab = 'active'"
      >
        监控中
        <span v-if="alertStore.enabledAlerts.length > 0" class="tab-badge">
          {{ alertStore.enabledAlerts.length }}
        </span>
      </span>
      <span 
        class="tab-item" 
        :class="{ active: activeTab === 'triggered' }"
        @click="activeTab = 'triggered'"
      >
        已触发
      </span>
      <span 
        class="tab-item" 
        :class="{ active: activeTab === 'all' }"
        @click="activeTab = 'all'"
      >
        全部
      </span>
    </div>
    
    <!-- 提醒列表 -->
    <div class="alert-list">
      <van-empty v-if="filteredAlerts.length === 0" description="暂无提醒规则" />
      
      <div 
        v-for="alert in filteredAlerts" 
        :key="alert.id"
        class="alert-item"
      >
        <div class="alert-main">
          <div class="alert-header">
            <span class="fund-name">{{ alert.name }}</span>
            <van-tag :type="getStatusTag(alert).type">
              {{ getStatusTag(alert).text }}
            </van-tag>
          </div>
          <div class="alert-info">
            <span class="alert-type">{{ getTypeLabel(alert.type) }}</span>
            <span class="alert-threshold">{{ getThresholdText(alert) }}</span>
          </div>
          <div class="alert-time">
            创建于 {{ formatTime(alert.createdAt) }}
          </div>
        </div>
        
        <div class="alert-actions">
          <van-switch 
            :model-value="alert.enabled" 
            size="20px"
            @update:model-value="toggleAlert(alert)"
          />
          <van-icon 
            name="delete-o" 
            size="20" 
            class="delete-btn"
            @click="deleteAlert(alert)"
          />
        </div>
      </div>
    </div>
    
    <!-- 底部操作栏 -->
    <div class="bottom-bar">
      <van-button 
        size="small" 
        @click="resetTriggered"
      >
        重置已触发
      </van-button>
      <van-button 
        size="small" 
        type="danger" 
        plain
        @click="clearAll"
      >
        清空全部
      </van-button>
    </div>
    
    <!-- 添加提醒弹窗 -->
    <van-popup 
      v-model:show="showAddDialog" 
      position="bottom"
      round
      :style="{ height: '50%' }"
    >
      <div class="add-dialog">
        <div class="dialog-header">
          <span class="dialog-title">添加提醒</span>
          <van-icon name="cross" size="20" @click="showAddDialog = false" />
        </div>
        
        <div class="dialog-content">
          <!-- 选择基金 -->
          <div class="field-item" @click="showFundPicker = true">
            <span class="field-label">选择基金</span>
            <div class="field-value">
              <span v-if="addForm.code">{{ addForm.name || addForm.code }}</span>
              <span v-else class="placeholder">从自选中选择</span>
              <van-icon name="arrow" size="14" />
            </div>
          </div>
          
          <!-- 提醒类型 -->
          <div class="field-item">
            <span class="field-label">提醒类型</span>
            <div class="type-options">
              <span 
                v-for="t in alertTypes" 
                :key="t.value"
                class="type-btn"
                :class="{ active: addForm.type === t.value }"
                @click="addForm.type = t.value"
              >
                {{ t.label }}
              </span>
            </div>
          </div>
          
          <!-- 阈值 -->
          <div class="field-item">
            <span class="field-label">阈值</span>
            <div class="input-wrapper">
              <input 
                v-model="addForm.threshold"
                type="number"
                :placeholder="alertTypes.find(t => t.value === addForm.type)?.unit === '%' ? '如: 3' : '如: 1.5000'"
                class="threshold-input"
              />
              <span class="input-unit">
                {{ alertTypes.find(t => t.value === addForm.type)?.unit }}
              </span>
            </div>
          </div>
          
          <van-button 
            type="primary" 
            block 
            @click="submitAdd"
          >
            添加提醒
          </van-button>
        </div>
      </div>
    </van-popup>
    
    <!-- 基金选择弹窗 -->
    <van-popup 
      v-model:show="showFundPicker" 
      position="bottom"
      round
      :style="{ height: '50%' }"
    >
      <div class="fund-picker">
        <div class="picker-title">从自选中选择</div>
        <div v-if="watchlistOptions.length === 0" class="empty-tip">
          暂无自选基金
        </div>
        <div v-else class="fund-list">
          <div 
            v-for="item in watchlistOptions" 
            :key="item.code"
            class="fund-item"
            @click="selectFund(item)"
          >
            <span class="fund-name">{{ item.name }}</span>
            <span class="fund-code">{{ item.code }}</span>
          </div>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.alerts-page {
  min-height: 100vh;
  background: var(--bg-primary);
  padding-bottom: 80px;
}

/* Tab 栏 */
.tab-bar {
  display: flex;
  background: var(--bg-secondary);
  padding: 0 16px;
  border-bottom: 1px solid var(--border-color);
}

.tab-item {
  position: relative;
  padding: 14px 16px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
}

.tab-item.active {
  color: var(--color-primary);
  font-weight: 500;
}

.tab-item.active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 16px;
  right: 16px;
  height: 2px;
  background: var(--color-primary);
  border-radius: 1px;
}

.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 10px;
  color: #fff;
  background: var(--color-primary);
  border-radius: 8px;
  margin-left: 4px;
}

/* 提醒列表 */
.alert-list {
  padding: 12px 16px;
}

.alert-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px;
  background: var(--bg-secondary);
  border-radius: 10px;
  margin-bottom: 10px;
}

.alert-main {
  flex: 1;
  min-width: 0;
}

.alert-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.fund-name {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.alert-info {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.alert-type {
  font-size: 13px;
  color: var(--text-secondary);
}

.alert-threshold {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-primary);
  font-family: 'DIN Alternate', 'Roboto Mono', monospace;
}

.alert-time {
  font-size: 11px;
  color: var(--text-muted);
}

.alert-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.delete-btn {
  color: var(--text-secondary);
  cursor: pointer;
}

.delete-btn:active {
  color: var(--color-down);
}

/* 底部操作栏 */
.bottom-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  padding-bottom: calc(12px + env(safe-area-inset-bottom));
}

/* 添加弹窗 */
.add-dialog {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.dialog-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}

.dialog-content {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
}

.field-item {
  margin-bottom: 16px;
}

.field-label {
  display: block;
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.field-value {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  cursor: pointer;
}

.placeholder {
  color: var(--text-muted);
}

.type-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.type-btn {
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 6px;
  cursor: pointer;
}

.type-btn.active {
  color: #fff;
  background: var(--color-primary);
}

.input-wrapper {
  display: flex;
  align-items: center;
  padding: 0 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.threshold-input {
  flex: 1;
  padding: 12px 0;
  font-size: 14px;
  color: var(--text-primary);
  background: transparent;
  border: none;
}

.input-unit {
  font-size: 14px;
  color: var(--text-secondary);
}

/* 基金选择器 */
.fund-picker {
  padding: 16px;
}

.picker-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  text-align: center;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.empty-tip {
  text-align: center;
  padding: 40px 0;
  color: var(--text-secondary);
}

.fund-list {
  margin-top: 12px;
}

.fund-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
}

.fund-item:active {
  background: var(--bg-tertiary);
}

.fund-name {
  font-size: 15px;
  color: var(--text-primary);
}

.fund-code {
  font-size: 13px;
  color: var(--text-muted);
  font-family: 'Roboto Mono', monospace;
}
</style>
