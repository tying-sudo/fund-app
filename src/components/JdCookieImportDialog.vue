<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{ show: boolean; title?: string }>()
const emit = defineEmits<{ 'update:show': [value: boolean]; confirm: [cookie: string] }>()
const STORAGE_KEY = 'fund-app:jd-cookie:v1'

function restoreCookie(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

const cookie = ref(restoreCookie())

watch(() => props.show, (visible) => {
  if (visible) cookie.value = restoreCookie()
})

function submit() {
  const value = cookie.value.trim().replace(/^cookie\s*:\s*/i, '')
  if (!value || !value.includes('=')) return
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // The one-time read remains available when device storage is blocked.
  }
  emit('confirm', value)
  emit('update:show', false)
}

function clearCookie() {
  cookie.value = ''
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // The input has still been cleared for this page instance.
  }
}
</script>

<template>
  <van-popup :show="show" position="bottom" round @close="emit('update:show', false)">
    <section class="jd-cookie-dialog">
      <div class="dialog-header">
        <h2>{{ title || '京东 Cookie 读取' }}</h2>
        <span class="dialog-tools">
          <button v-if="cookie" type="button" class="icon-button" title="清除已保存 Cookie" aria-label="清除已保存 Cookie" @click="clearCookie"><van-icon name="delete-o" size="18" /></button>
          <button type="button" class="icon-button" title="关闭" aria-label="关闭" @click="emit('update:show', false)"><van-icon name="cross" size="20" /></button>
        </span>
      </div>
      <van-field
        v-model="cookie"
        label="Cookie"
        type="textarea"
        rows="4"
        maxlength="16384"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="pt_key=...; pt_pin=..."
      />
      <div class="dialog-actions">
        <van-button block type="primary" :disabled="!cookie.trim()" @click="submit">读取持仓</van-button>
      </div>
    </section>
  </van-popup>
</template>

<style scoped>
.jd-cookie-dialog { padding: 16px; background: var(--bg-secondary); }
.dialog-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.dialog-header h2 { margin: 0; color: var(--text-primary); font-size: 17px; line-height: 24px; }
.dialog-tools { display: inline-flex; gap: 6px; }
.icon-button { display: grid; width: 30px; height: 30px; place-items: center; padding: 0; color: var(--text-secondary); background: transparent; border: 0; }
.dialog-actions { margin-top: 16px; }
</style>
