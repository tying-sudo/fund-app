// [WHY] 智能提醒状态管理，监控基金涨跌幅并发送通知
// [WHAT] 提供提醒规则的增删改查，支持涨跌幅提醒、目标价提醒
// [DEPS] 依赖 Web Notification API 发送通知

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

// ========== 类型定义 ==========

export type AlertType = 'change_up' | 'change_down' | 'target_high' | 'target_low'

export interface AlertRule {
  /** 规则ID */
  id: string
  /** 基金代码 */
  code: string
  /** 基金名称 */
  name: string
  /** 提醒类型 */
  type: AlertType
  /** 阈值（涨跌幅为百分比，目标价为净值） */
  threshold: number
  /** 是否启用 */
  enabled: boolean
  /** 是否已触发（触发后不重复提醒） */
  triggered: boolean
  /** 创建时间 */
  createdAt: number
}

// [WHAT] 提醒类型配置
export const ALERT_TYPE_CONFIG = {
  change_up: { label: '涨幅超过', unit: '%', icon: 'arrow-up' },
  change_down: { label: '跌幅超过', unit: '%', icon: 'arrow-down' },
  target_high: { label: '估值高于', unit: '', icon: 'chart-trending-o' },
  target_low: { label: '估值低于', unit: '', icon: 'chart-trending-o' }
} as const

// [WHAT] localStorage 存储键
const STORAGE_KEY = 'fund_alerts'

// [WHAT] 生成唯一 ID
function generateId(): string {
  return `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// [WHAT] 从 localStorage 读取数据
function loadAlerts(): AlertRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

// [WHAT] 保存数据到 localStorage
function saveAlerts(alerts: AlertRule[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts))
}

export const useAlertStore = defineStore('alert', () => {
  // ========== State ==========

  /** 所有提醒规则 */
  const alerts = ref<AlertRule[]>(loadAlerts())
  
  /** 通知权限状态 */
  const notificationPermission = ref<NotificationPermission>('default')

  // ========== Getters ==========

  /** 启用的提醒规则 */
  const enabledAlerts = computed(() => alerts.value.filter(a => a.enabled && !a.triggered))

  /** 获取指定基金的提醒规则 */
  function getAlertsByFund(code: string): AlertRule[] {
    return alerts.value.filter(a => a.code === code)
  }

  // ========== Actions ==========

  /**
   * 请求通知权限
   */
  async function requestNotificationPermission(): Promise<boolean> {
    if (!('Notification' in window)) {
      console.warn('浏览器不支持通知')
      return false
    }

    if (Notification.permission === 'granted') {
      notificationPermission.value = 'granted'
      return true
    }

    if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission()
      notificationPermission.value = permission
      return permission === 'granted'
    }

    return false
  }

  /**
   * 发送通知
   */
  function sendNotification(title: string, body: string, icon?: string) {
    if (Notification.permission !== 'granted') return

    try {
      new Notification(title, {
        body,
        icon: icon || '/vite.svg',
        tag: 'fund-alert',
        requireInteraction: true
      })
    } catch (err) {
      console.error('发送通知失败:', err)
    }
  }

  /**
   * 添加提醒规则
   */
  function addAlert(rule: Omit<AlertRule, 'id' | 'triggered' | 'createdAt'>): AlertRule {
    const newRule: AlertRule = {
      ...rule,
      id: generateId(),
      triggered: false,
      createdAt: Date.now()
    }
    alerts.value.push(newRule)
    saveAlerts(alerts.value)
    return newRule
  }

  /**
   * 更新提醒规则
   */
  function updateAlert(id: string, updates: Partial<AlertRule>): boolean {
    const index = alerts.value.findIndex(a => a.id === id)
    if (index === -1) return false

    alerts.value[index] = { ...alerts.value[index], ...updates }
    saveAlerts(alerts.value)
    return true
  }

  /**
   * 删除提醒规则
   */
  function deleteAlert(id: string): boolean {
    const index = alerts.value.findIndex(a => a.id === id)
    if (index === -1) return false

    alerts.value.splice(index, 1)
    saveAlerts(alerts.value)
    return true
  }

  /**
   * 切换规则启用状态
   */
  function toggleAlert(id: string): boolean {
    const index = alerts.value.findIndex(a => a.id === id)
    if (index === -1) return false

    alerts.value[index].enabled = !alerts.value[index].enabled
    // 重新启用时重置触发状态
    if (alerts.value[index].enabled) {
      alerts.value[index].triggered = false
    }
    saveAlerts(alerts.value)
    return true
  }

  /**
   * 检查提醒条件
   * @param code 基金代码
   * @param currentValue 当前估值
   * @param changeRate 涨跌幅
   */
  function checkAlerts(code: string, currentValue: number, changeRate: number) {
    const fundAlerts = getAlertsByFund(code).filter(a => a.enabled && !a.triggered)

    for (const alert of fundAlerts) {
      let shouldTrigger = false
      let message = ''

      switch (alert.type) {
        case 'change_up':
          if (changeRate >= alert.threshold) {
            shouldTrigger = true
            message = `涨幅达到 ${changeRate.toFixed(2)}%，超过预设的 ${alert.threshold}%`
          }
          break
        case 'change_down':
          if (changeRate <= -alert.threshold) {
            shouldTrigger = true
            message = `跌幅达到 ${Math.abs(changeRate).toFixed(2)}%，超过预设的 ${alert.threshold}%`
          }
          break
        case 'target_high':
          if (currentValue >= alert.threshold) {
            shouldTrigger = true
            message = `估值 ${currentValue.toFixed(4)} 已达到目标高位 ${alert.threshold}`
          }
          break
        case 'target_low':
          if (currentValue <= alert.threshold) {
            shouldTrigger = true
            message = `估值 ${currentValue.toFixed(4)} 已达到目标低位 ${alert.threshold}`
          }
          break
      }

      if (shouldTrigger) {
        // 标记为已触发
        updateAlert(alert.id, { triggered: true })
        // 发送通知
        sendNotification(
          `${alert.name} 提醒`,
          message
        )
      }
    }
  }

  /**
   * 重置所有已触发的提醒
   */
  function resetTriggeredAlerts() {
    let changed = false
    for (const alert of alerts.value) {
      if (alert.triggered) {
        alert.triggered = false
        changed = true
      }
    }
    if (changed) {
      saveAlerts(alerts.value)
    }
  }

  /**
   * 清空所有提醒
   */
  function clearAllAlerts() {
    alerts.value = []
    saveAlerts(alerts.value)
  }

  // 初始化时检查通知权限
  if ('Notification' in window) {
    notificationPermission.value = Notification.permission
  }

  return {
    // State
    alerts,
    notificationPermission,
    // Getters
    enabledAlerts,
    // Actions
    getAlertsByFund,
    requestNotificationPermission,
    sendNotification,
    addAlert,
    updateAlert,
    deleteAlert,
    toggleAlert,
    checkAlerts,
    resetTriggeredAlerts,
    clearAllAlerts
  }
})
