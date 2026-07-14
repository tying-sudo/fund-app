<script setup lang="ts">
// [WHY] 投资日历 - 展示分红日、申购赎回开放日等重要事件
// [WHAT] 日历视图 + 事件列表，支持手动添加提醒事件

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useFundStore } from '@/stores/fund'
import { showToast, showConfirmDialog } from 'vant'

const router = useRouter()
const fundStore = useFundStore()

// 当前日期
const today = new Date()
const currentYear = ref(today.getFullYear())
const currentMonth = ref(today.getMonth())

// 选中的日期
const selectedDate = ref<string>(formatDateKey(today))

// 事件数据
interface CalendarEvent {
  id: string
  date: string        // YYYY-MM-DD
  fundCode: string
  fundName: string
  type: 'dividend' | 'subscribe' | 'redeem' | 'other'
  title: string
  description?: string
}

// 事件类型配置
const EVENT_TYPES = {
  dividend: { label: '分红', color: '#f6465d', icon: 'gold-coin-o' },
  subscribe: { label: '申购开放', color: '#0ecb81', icon: 'plus' },
  redeem: { label: '赎回开放', color: '#1e90ff', icon: 'minus' },
  other: { label: '其他', color: '#f7931a', icon: 'info-o' }
}

// 事件列表（持久化存储）
const events = ref<CalendarEvent[]>(loadEvents())

// 添加事件弹窗
const showAddDialog = ref(false)
const addForm = ref({
  date: selectedDate.value,
  fundCode: '',
  fundName: '',
  type: 'dividend' as CalendarEvent['type'],
  title: '',
  description: ''
})

// 基金选择弹窗
const showFundPicker = ref(false)

// [WHAT] 从 localStorage 读取事件
function loadEvents(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem('calendar_events')
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

// [WHAT] 保存事件到 localStorage
function saveEvents() {
  localStorage.setItem('calendar_events', JSON.stringify(events.value))
}

// [WHAT] 格式化日期为 key
function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`
}

// [WHAT] 获取月份天数
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

// [WHAT] 获取月份第一天是周几
function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay()
}

// [WHAT] 生成日历网格数据
const calendarDays = computed(() => {
  const daysInMonth = getDaysInMonth(currentYear.value, currentMonth.value)
  const firstDay = getFirstDayOfMonth(currentYear.value, currentMonth.value)
  
  const days: { date: string; day: number; isCurrentMonth: boolean; isToday: boolean; hasEvent: boolean }[] = []
  
  // 上月补位
  const prevMonth = currentMonth.value === 0 ? 11 : currentMonth.value - 1
  const prevYear = currentMonth.value === 0 ? currentYear.value - 1 : currentYear.value
  const daysInPrevMonth = getDaysInMonth(prevYear, prevMonth)
  
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = daysInPrevMonth - i
    const date = `${prevYear}-${(prevMonth + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
    days.push({
      date,
      day,
      isCurrentMonth: false,
      isToday: false,
      hasEvent: events.value.some(e => e.date === date)
    })
  }
  
  // 当月
  const todayKey = formatDateKey(today)
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${currentYear.value}-${(currentMonth.value + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
    days.push({
      date,
      day,
      isCurrentMonth: true,
      isToday: date === todayKey,
      hasEvent: events.value.some(e => e.date === date)
    })
  }
  
  // 下月补位（补齐6行）
  const remaining = 42 - days.length
  const nextMonth = currentMonth.value === 11 ? 0 : currentMonth.value + 1
  const nextYear = currentMonth.value === 11 ? currentYear.value + 1 : currentYear.value
  
  for (let day = 1; day <= remaining; day++) {
    const date = `${nextYear}-${(nextMonth + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
    days.push({
      date,
      day,
      isCurrentMonth: false,
      isToday: false,
      hasEvent: events.value.some(e => e.date === date)
    })
  }
  
  return days
})

// [WHAT] 当前月份名称
const monthName = computed(() => {
  return `${currentYear.value}年${currentMonth.value + 1}月`
})

// [WHAT] 选中日期的事件
const selectedEvents = computed(() => {
  return events.value.filter(e => e.date === selectedDate.value)
})

// [WHAT] 切换月份
function prevMonth() {
  if (currentMonth.value === 0) {
    currentMonth.value = 11
    currentYear.value--
  } else {
    currentMonth.value--
  }
}

function nextMonth() {
  if (currentMonth.value === 11) {
    currentMonth.value = 0
    currentYear.value++
  } else {
    currentMonth.value++
  }
}

// [WHAT] 选择日期
function selectDate(date: string) {
  selectedDate.value = date
}

// [WHAT] 选择基金
function selectFund(item: { code: string; name: string }) {
  addForm.value.fundCode = item.code
  addForm.value.fundName = item.name
  showFundPicker.value = false
}

// [WHAT] 提交添加事件
function submitAdd() {
  if (!addForm.value.fundCode) {
    showToast('请选择基金')
    return
  }
  if (!addForm.value.title.trim()) {
    showToast('请输入事件标题')
    return
  }
  
  const newEvent: CalendarEvent = {
    id: `event_${Date.now()}`,
    date: addForm.value.date,
    fundCode: addForm.value.fundCode,
    fundName: addForm.value.fundName,
    type: addForm.value.type,
    title: addForm.value.title.trim(),
    description: addForm.value.description.trim()
  }
  
  events.value.push(newEvent)
  saveEvents()
  
  showToast('添加成功')
  showAddDialog.value = false
  
  // 重置表单
  addForm.value = {
    date: selectedDate.value,
    fundCode: '',
    fundName: '',
    type: 'dividend',
    title: '',
    description: ''
  }
}

// [WHAT] 删除事件
async function deleteEvent(event: CalendarEvent) {
  try {
    await showConfirmDialog({
      title: '删除事件',
      message: `确定删除「${event.title}」？`
    })
    
    const index = events.value.findIndex(e => e.id === event.id)
    if (index !== -1) {
      events.value.splice(index, 1)
      saveEvents()
      showToast('已删除')
    }
  } catch {
    // 用户取消
  }
}

// [WHAT] 获取事件类型配置
function getEventType(type: CalendarEvent['type']) {
  return EVENT_TYPES[type]
}

// 自选基金列表
const watchlistOptions = computed(() => {
  return fundStore.watchlist.map(f => ({
    code: f.code,
    name: f.name || f.code
  }))
})

// 打开添加弹窗
function openAddDialog() {
  addForm.value.date = selectedDate.value
  showAddDialog.value = true
}

// 星期标题
const weekDays = ['日', '一', '二', '三', '四', '五', '六']
</script>

<template>
  <div class="calendar-page">
    <!-- 导航栏 -->
    <van-nav-bar 
      title="投资日历" 
      left-arrow 
      @click-left="router.back()"
    >
      <template #right>
        <van-icon name="plus" size="20" @click="openAddDialog" />
      </template>
    </van-nav-bar>
    
    <!-- 月份切换 -->
    <div class="month-bar">
      <van-icon name="arrow-left" size="20" @click="prevMonth" />
      <span class="month-name">{{ monthName }}</span>
      <van-icon name="arrow" size="20" @click="nextMonth" />
    </div>
    
    <!-- 日历网格 -->
    <div class="calendar-grid">
      <!-- 星期标题 -->
      <div class="weekday-row">
        <span v-for="day in weekDays" :key="day" class="weekday-cell">{{ day }}</span>
      </div>
      
      <!-- 日期网格 -->
      <div class="days-grid">
        <div 
          v-for="day in calendarDays" 
          :key="day.date"
          class="day-cell"
          :class="{
            'other-month': !day.isCurrentMonth,
            'today': day.isToday,
            'selected': day.date === selectedDate,
            'has-event': day.hasEvent
          }"
          @click="selectDate(day.date)"
        >
          <span class="day-number">{{ day.day }}</span>
          <span v-if="day.hasEvent" class="event-dot"></span>
        </div>
      </div>
    </div>
    
    <!-- 选中日期的事件 -->
    <div class="events-section">
      <div class="events-header">
        <span class="events-date">{{ selectedDate }}</span>
        <span class="events-count">{{ selectedEvents.length }}个事件</span>
      </div>
      
      <div v-if="selectedEvents.length === 0" class="events-empty">
        <span>暂无事件</span>
        <van-button size="small" type="primary" @click="openAddDialog">添加事件</van-button>
      </div>
      
      <div v-else class="events-list">
        <div 
          v-for="event in selectedEvents" 
          :key="event.id"
          class="event-item"
        >
          <div 
            class="event-type-badge"
            :style="{ background: getEventType(event.type).color }"
          >
            <van-icon :name="getEventType(event.type).icon" size="14" />
          </div>
          <div class="event-content">
            <div class="event-title">{{ event.title }}</div>
            <div class="event-fund">{{ event.fundName }}</div>
            <div v-if="event.description" class="event-desc">{{ event.description }}</div>
          </div>
          <van-icon 
            name="delete-o" 
            size="18" 
            class="delete-btn"
            @click="deleteEvent(event)"
          />
        </div>
      </div>
    </div>
    
    <!-- 添加事件弹窗 -->
    <van-popup 
      v-model:show="showAddDialog" 
      position="bottom"
      round
      :style="{ height: '70%' }"
    >
      <div class="add-dialog">
        <div class="dialog-header">
          <span class="dialog-title">添加事件</span>
          <van-icon name="cross" size="20" @click="showAddDialog = false" />
        </div>
        
        <div class="dialog-content">
          <!-- 日期 -->
          <div class="field-item">
            <span class="field-label">日期</span>
            <input 
              v-model="addForm.date"
              type="date"
              class="date-input"
            />
          </div>
          
          <!-- 选择基金 -->
          <div class="field-item" @click="showFundPicker = true">
            <span class="field-label">基金</span>
            <div class="field-value">
              <span v-if="addForm.fundCode">{{ addForm.fundName || addForm.fundCode }}</span>
              <span v-else class="placeholder">从自选中选择</span>
              <van-icon name="arrow" size="14" />
            </div>
          </div>
          
          <!-- 事件类型 -->
          <div class="field-item">
            <span class="field-label">类型</span>
            <div class="type-options">
              <span 
                v-for="(config, key) in EVENT_TYPES" 
                :key="key"
                class="type-btn"
                :class="{ active: addForm.type === key }"
                :style="addForm.type === key ? { background: config.color } : {}"
                @click="addForm.type = key as CalendarEvent['type']"
              >
                {{ config.label }}
              </span>
            </div>
          </div>
          
          <!-- 标题 -->
          <div class="field-item">
            <span class="field-label">标题</span>
            <input 
              v-model="addForm.title"
              type="text"
              placeholder="如：现金分红"
              class="text-input"
            />
          </div>
          
          <!-- 备注 -->
          <div class="field-item">
            <span class="field-label">备注</span>
            <textarea 
              v-model="addForm.description"
              placeholder="可选"
              class="textarea-input"
              rows="2"
            ></textarea>
          </div>
          
          <van-button 
            type="primary" 
            block 
            @click="submitAdd"
          >
            添加事件
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
.calendar-page {
  min-height: 100vh;
  background: var(--bg-primary);
}

/* 月份切换 */
.month-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  background: var(--bg-secondary);
}

.month-name {
  font-size: 18px;
  font-weight: 500;
  color: var(--text-primary);
}

/* 日历网格 */
.calendar-grid {
  background: var(--bg-secondary);
  padding: 0 12px 16px;
}

.weekday-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 8px;
}

.weekday-cell {
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 8px 0;
}

.days-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.day-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 44px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.day-cell:active {
  background: var(--bg-tertiary);
}

.day-number {
  font-size: 14px;
  color: var(--text-primary);
}

.day-cell.other-month .day-number {
  color: var(--text-muted);
}

.day-cell.today {
  background: var(--bg-tertiary);
}

.day-cell.today .day-number {
  color: var(--color-primary);
  font-weight: 600;
}

.day-cell.selected {
  background: var(--color-primary);
}

.day-cell.selected .day-number {
  color: #fff;
}

.event-dot {
  position: absolute;
  bottom: 6px;
  width: 4px;
  height: 4px;
  background: var(--color-up);
  border-radius: 50%;
}

.day-cell.selected .event-dot {
  background: #fff;
}

/* 事件区域 */
.events-section {
  margin: 12px;
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 16px;
}

.events-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.events-date {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.events-count {
  font-size: 13px;
  color: var(--text-secondary);
}

.events-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 24px 0;
  color: var(--text-secondary);
}

.events-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.event-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.event-type-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: #fff;
  flex-shrink: 0;
}

.event-content {
  flex: 1;
  min-width: 0;
}

.event-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.event-fund {
  font-size: 12px;
  color: var(--text-secondary);
}

.event-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.delete-btn {
  color: var(--text-muted);
  cursor: pointer;
}

.delete-btn:active {
  color: var(--color-down);
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
}

.date-input,
.text-input,
.textarea-input {
  width: 100%;
  padding: 12px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: none;
  border-radius: 8px;
}

.textarea-input {
  resize: none;
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
  max-height: 300px;
  overflow-y: auto;
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
