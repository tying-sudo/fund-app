// [WHY] 应用设置状态管理
// [WHAT] 管理刷新间隔等用户设置

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const STORAGE_KEY = 'fund_settings'

export interface AppSettings {
  /** 盘中刷新间隔（秒）- 最低1秒 */
  tradingInterval: number
  /** 盘后刷新间隔（秒）- 默认3分钟 */
  afterHoursInterval: number
  /** 是否启用自动刷新 */
  autoRefresh: boolean
}

function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      return {
        tradingInterval: Math.max(1, parsed.tradingInterval || 5),
        afterHoursInterval: parsed.afterHoursInterval || 180,
        autoRefresh: parsed.autoRefresh !== false
      }
    }
  } catch {}
  return {
    tradingInterval: 5,
    afterHoursInterval: 180,
    autoRefresh: true
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(loadSettings())

  /** 盘中刷新间隔（秒） */
  const tradingInterval = computed(() => settings.value.tradingInterval)
  
  /** 盘后刷新间隔（秒） */
  const afterHoursInterval = computed(() => settings.value.afterHoursInterval)
  
  /** 是否自动刷新 */
  const autoRefresh = computed(() => settings.value.autoRefresh)

  /** 保存设置 */
  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.value))
  }

  /** 设置盘中刷新间隔 */
  function setTradingInterval(seconds: number) {
    settings.value.tradingInterval = Math.max(1, Math.min(60, seconds))
    saveSettings()
  }

  /** 设置盘后刷新间隔 */
  function setAfterHoursInterval(seconds: number) {
    settings.value.afterHoursInterval = Math.max(30, Math.min(600, seconds))
    saveSettings()
  }

  /** 切换自动刷新 */
  function toggleAutoRefresh() {
    settings.value.autoRefresh = !settings.value.autoRefresh
    saveSettings()
  }

  return {
    settings,
    tradingInterval,
    afterHoursInterval,
    autoRefresh,
    setTradingInterval,
    setAfterHoursInterval,
    toggleAutoRefresh
  }
})