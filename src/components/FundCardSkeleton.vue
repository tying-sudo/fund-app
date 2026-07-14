<script setup lang="ts">
// [WHY] 基金卡片骨架屏组件
// [WHAT] 在数据加载时显示占位骨架，提升用户体验
</script>

<template>
  <div class="fund-card-skeleton">
    <div class="skeleton-left">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-text" style="width: 40%; margin-top: 8px;"></div>
    </div>
    <div class="skeleton-right">
      <div class="skeleton skeleton-title" style="width: 60px;"></div>
      <div class="skeleton skeleton-text" style="width: 40px; margin-top: 8px;"></div>
    </div>
  </div>
</template>

<style scoped>
.fund-card-skeleton {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-color);
}

.skeleton-left {
  flex: 1;
}

.skeleton-right {
  text-align: right;
}
</style>
