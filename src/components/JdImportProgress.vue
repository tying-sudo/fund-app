<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  show: boolean
  title?: string
  message: string
  percentage: number
}>(), {
  title: '京东账户读取'
})

const progress = computed(() => Math.min(100, Math.max(0, Math.round(props.percentage))))
</script>

<template>
  <van-popup
    :show="show"
    class="jd-import-progress"
    :close-on-click-overlay="false"
    :closeable="false"
    :safe-area-inset-bottom="true"
  >
    <section class="jd-import-progress-content" aria-live="polite">
      <van-loading size="28px" color="#1989fa" />
      <div class="jd-import-progress-title">{{ title }}</div>
      <div class="jd-import-progress-message">{{ message }}</div>
      <div
        class="jd-import-progress-track"
        role="progressbar"
        :aria-label="`${title}进度`"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="progress"
      >
        <span class="jd-import-progress-fill" :style="{ width: `${progress}%` }"></span>
      </div>
    </section>
  </van-popup>
</template>

<style scoped>
.jd-import-progress {
  width: min(280px, calc(100vw - 48px));
  box-sizing: border-box;
  overflow: hidden;
  padding: 0;
  border-radius: 8px;
}

.jd-import-progress-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  padding: 24px;
  text-align: center;
}

.jd-import-progress :deep(.van-loading) {
  justify-self: center;
  margin: 0;
}

.jd-import-progress-title {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
}

.jd-import-progress-message {
  min-height: 40px;
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.jd-import-progress-track {
  position: relative;
  width: 100%;
  height: 5px;
  margin-top: 2px;
  overflow: hidden;
  background: var(--border-color, rgba(255, 255, 255, 0.18));
  border-radius: 999px;
}

.jd-import-progress-fill {
  display: block;
  height: 100%;
  min-width: 2px;
  background: #1989fa;
  border-radius: inherit;
  transition: width 180ms ease-out;
}
</style>
