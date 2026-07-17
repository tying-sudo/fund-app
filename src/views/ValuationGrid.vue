<script setup lang="ts">
defineOptions({ name: 'ValuationGrid' })

const gridUrl = import.meta.env.VITE_VALUATION_GRID_URL || 'http://10.0.10.20:8080/'
</script>

<template>
  <main class="valuation-grid-page">
    <iframe
      class="valuation-grid-frame"
      :src="gridUrl"
      title="估值网格"
      allow="clipboard-read; clipboard-write"
    />
  </main>
</template>

<style scoped>
.valuation-grid-page {
  height: calc(100vh - 50px);
  background: var(--bg-primary);
}

.valuation-grid-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--bg-primary);
}
</style>
