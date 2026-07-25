<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DataSource, FundEstimateWithSource } from '@/types/fund'
import { ALL_DATA_SOURCES, DATA_SOURCE_CONFIG } from '@/types/fund'
import { useFundStore } from '@/stores/fund'

type SelectorSource = FundEstimateWithSource & {
  kind?: 'estimate' | 'official_nav'
  available?: boolean
  note?: string
}

const props = defineProps<{ show: boolean; fundCode: string; fundName: string }>()
const emit = defineEmits<{ 'update:show': [value: boolean]; select: [source: DataSource] }>()
const fundStore = useFundStore()

const loading = ref(false)
const sources = ref<Partial<Record<DataSource, SelectorSource>>>({})
const recommended = ref<DataSource | null>(null)
const recommendationReason = ref('')
const pendingSource = ref<DataSource>('tiantian')
const autoMode = ref(false)

function storageKey() { return `fund-app:valuation-source:auto:${props.fundCode}` }

watch(() => props.show, async visible => {
  if (!visible || !props.fundCode) return
  autoMode.value = localStorage.getItem(storageKey()) === 'true'
  pendingSource.value = fundStore.getFundDataSource(props.fundCode)
  loading.value = true
  try {
    const result = await fundStore.getAllSourcesForFund(props.fundCode)
    sources.value = result.sources as Partial<Record<DataSource, SelectorSource>>
    recommended.value = (result as any).recommended || null
    recommendationReason.value = (result as any).recommendationReason || ''
    if (autoMode.value && recommended.value) pendingSource.value = recommended.value
  } finally {
    loading.value = false
  }
})

const sourceRows = computed(() => ALL_DATA_SOURCES.map(source => ({
  source,
  data: sources.value[source],
  selectable: Boolean(sources.value[source]?.available && sources.value[source]?.gszzl !== '--')
})))

function formatChange(value?: string) {
  const number = Number(value)
  return Number.isFinite(number) ? `${number >= 0 ? '+' : ''}${number.toFixed(2)}%` : '--'
}

function changeClass(value?: string) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 'flat'
  return number > 0 ? 'up' : number < 0 ? 'down' : 'flat'
}

function select(source: DataSource, selectable: boolean) {
  if (selectable) pendingSource.value = source
}

function toggleAuto(value: boolean) {
  autoMode.value = value
  localStorage.setItem(storageKey(), String(value))
  if (value && recommended.value) pendingSource.value = recommended.value
}

function confirm() {
  const selected = sources.value[pendingSource.value]
  if (!selected?.available || selected.gszzl === '--') return
  emit('select', pendingSource.value)
  emit('update:show', false)
}
</script>

<template>
  <van-popup :show="show" position="center" :style="{ width: 'min(92vw, 392px)' }" @close="emit('update:show', false)">
    <section class="valuation-source-dialog" aria-label="切换估值源">
      <div class="dialog-hint" v-if="recommendationReason">{{ recommendationReason }}</div>
      <div class="dialog-title-row">
        <h2>切换估值源</h2>
        <label class="auto-control">
          <span>自动</span>
          <van-switch :model-value="autoMode" size="18px" active-color="#f0a500" @update:model-value="toggleAuto" />
        </label>
        <van-icon name="question-o" size="16" class="help-icon" />
      </div>
      <p class="fund-caption">{{ fundName }} · {{ fundCode }}</p>

      <div class="source-list" :class="{ loading }">
        <button
          v-for="row in sourceRows"
          :key="row.source"
          type="button"
          :class="['source-row', { active: pendingSource === row.source, disabled: !row.selectable }]"
          :disabled="!row.selectable"
          @click="select(row.source, row.selectable)"
        >
          <span :class="['radio', { checked: pendingSource === row.source }]" aria-hidden="true"></span>
          <span class="source-copy">
            <span class="source-name">{{ DATA_SOURCE_CONFIG[row.source].name }}</span>
            <span v-if="recommended === row.source" class="recommendation">自动建议</span>
            <span class="source-meta">{{ row.data?.kind === 'official_nav' ? '最新已公布净值' : (row.data?.gztime || DATA_SOURCE_CONFIG[row.source].description) }}</span>
          </span>
          <span class="source-value">
            <span class="value-label">{{ row.data?.kind === 'official_nav' ? '净值涨跌' : '当前估值' }}</span>
            <strong :class="changeClass(row.data?.gszzl)">{{ formatChange(row.data?.gszzl) }}</strong>
          </span>
        </button>
      </div>

      <div class="dialog-actions">
        <button type="button" class="action cancel" @click="emit('update:show', false)">取消</button>
        <button type="button" class="action confirm" :disabled="loading" @click="confirm">确定</button>
      </div>
    </section>
  </van-popup>
</template>

<style scoped>
.valuation-source-dialog { padding: 12px 20px 20px; background: #101827; color: #eef5ff; border: 1px solid #26354a; border-radius: 10px; }
.dialog-hint { width: max-content; max-width: 100%; margin: -12px auto 8px; padding: 6px 12px; overflow: hidden; color: #bcc8d8; font-size: 11px; white-space: nowrap; text-overflow: ellipsis; background: #202b3b; border-radius: 16px; }
.dialog-title-row { display: flex; align-items: center; gap: 9px; }
.dialog-title-row h2 { margin: 0; font-size: 18px; line-height: 28px; letter-spacing: 0; }
.auto-control { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; color: #f4b222; font-size: 12px; border: 1px solid #9b6f14; border-radius: 12px; }
.help-icon { color: #aab8cc; }
.fund-caption { margin: 2px 0 12px; color: #8091a9; font-size: 11px; }
.source-list { display: grid; gap: 10px; min-height: 218px; }
.source-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) 78px; align-items: center; gap: 10px; min-height: 64px; padding: 10px 12px; color: inherit; text-align: left; background: #0c1422; border: 1px solid #202d41; border-radius: 8px; }
.source-row.active { background: #132b3d; border-color: #10bde5; }
.source-row.disabled { opacity: .54; }
.radio { width: 15px; height: 15px; border: 1px solid #33445e; border-radius: 50%; }
.radio.checked { border: 4px solid #17c2eb; background: #101827; }
.source-copy, .source-value { min-width: 0; display: grid; gap: 4px; }
.source-name { color: #d5e0ef; font-size: 14px; }
.source-meta, .value-label { color: #8392a8; font-size: 10px; }
.recommendation { width: max-content; padding: 1px 5px; color: #f4b222; font-size: 10px; border: 1px solid #8c681d; border-radius: 8px; }
.source-value { text-align: right; }
.source-value strong { font-size: 18px; font-variant-numeric: tabular-nums; }
.up { color: #ef6b72; }.down { color: #25c6a1; }.flat { color: #9aa9bd; }
.dialog-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 20px; }
.action { height: 40px; font-size: 15px; font-weight: 600; border-radius: 8px; }
.cancel { color: #e7eef8; background: transparent; border: 1px solid #29384f; }
.confirm { color: #062233; background: #1dbfe7; border: 1px solid #52d4ef; }
.confirm:disabled { opacity: .55; }
</style>
