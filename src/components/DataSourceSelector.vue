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
const showHelp = ref(false)

function storageKey() { return `fund-app:valuation-source:auto:${props.fundCode}` }

watch(() => props.show, async visible => {
  if (!visible) {
    showHelp.value = false
    return
  }
  if (!props.fundCode) return
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
  <van-popup
    :show="show"
    class="valuation-source-popup"
    position="center"
    :style="{ width: 'min(92vw, 392px)', background: 'transparent' }"
    @close="emit('update:show', false)"
  >
    <section class="valuation-source-dialog" aria-label="切换估值源">
      <div class="dialog-title-row">
        <h2>切换估值源</h2>
        <label class="auto-control">
          <span>自动</span>
          <van-switch :model-value="autoMode" size="18px" @update:model-value="toggleAuto" />
        </label>
        <button type="button" class="help-button" title="估值说明" aria-label="估值说明" @click="showHelp = true">
          <van-icon name="question-o" size="17" />
        </button>
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

  <van-popup
    v-model:show="showHelp"
    class="valuation-help-popup"
    position="center"
    :style="{ width: 'min(88vw, 336px)', background: 'transparent' }"
  >
    <section class="valuation-help-dialog" aria-label="估值说明">
      <header>
        <h2>估值说明</h2>
        <button type="button" title="关闭" aria-label="关闭" @click="showHelp = false"><van-icon name="cross" size="18" /></button>
      </header>
      <p v-if="recommendationReason">{{ recommendationReason }}</p>
      <p>自动选择会优先使用当前交易日可用的盘中估值；盘中估值不可用时，会显示最新已公布净值作参考。</p>
      <button type="button" class="help-confirm" @click="showHelp = false">知道了</button>
    </section>
  </van-popup>
</template>

<style scoped>
.valuation-source-dialog,
.valuation-help-dialog { color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; box-shadow: 0 12px 36px rgb(0 0 0 / 24%); }
.valuation-source-dialog { display: flex; flex-direction: column; max-height: min(78dvh, 560px); padding: 18px; }
.dialog-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dialog-title-row h2 { margin: 0; font-size: 18px; line-height: 26px; letter-spacing: 0; }
.auto-control { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; margin-left: auto; color: var(--text-secondary); font-size: 12px; }
.auto-control :deep(.van-switch) { --van-switch-on-background: var(--primary-color); }
.help-button,
.valuation-help-dialog header button { display: inline-grid; flex: 0 0 auto; width: 28px; height: 28px; place-items: center; padding: 0; color: var(--text-secondary); background: transparent; border: 0; }
.help-button:active,
.valuation-help-dialog header button:active { color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 10%, transparent); border-radius: 50%; }
.fund-caption { margin: 3px 0 12px; overflow: hidden; color: var(--text-secondary); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.source-list { display: grid; flex: 1; gap: 8px; min-height: 0; overflow-y: auto; }
.source-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) 76px; align-items: center; gap: 10px; min-height: 64px; padding: 10px 12px; color: var(--text-primary); text-align: left; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; }
.source-row.active { background: color-mix(in srgb, var(--primary-color) 9%, var(--bg-secondary)); border-color: var(--primary-color); }
.source-row.disabled { opacity: .54; }
.radio { width: 15px; height: 15px; border: 1px solid var(--text-tertiary); border-radius: 50%; }
.radio.checked { border: 4px solid var(--primary-color); background: var(--bg-secondary); }
.source-copy, .source-value { min-width: 0; display: grid; gap: 4px; }
.source-name { overflow: hidden; color: var(--text-primary); font-size: 14px; white-space: nowrap; text-overflow: ellipsis; }
.source-meta, .value-label { overflow: hidden; color: var(--text-secondary); font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }
.recommendation { width: max-content; padding: 1px 5px; color: #c68c14; font-size: 10px; border: 1px solid currentColor; border-radius: 8px; }
.source-value { text-align: right; }
.source-value strong { font-size: 18px; font-variant-numeric: tabular-nums; }
.up { color: var(--color-up); }.down { color: var(--color-down); }.flat { color: var(--text-secondary); }
.dialog-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 16px; }
.action { height: 40px; font-size: 15px; font-weight: 600; border-radius: 8px; }
.cancel { color: var(--text-primary); background: transparent; border: 1px solid var(--border-color); }
.confirm { color: #fff; background: var(--primary-color); border: 1px solid var(--primary-color); }
.confirm:disabled { opacity: .55; }
.valuation-help-dialog { padding: 18px; }
.valuation-help-dialog header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.valuation-help-dialog h2 { margin: 0; font-size: 17px; line-height: 24px; }
.valuation-help-dialog p { margin: 0 0 10px; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.help-confirm { width: 100%; height: 38px; margin-top: 4px; color: #fff; font-size: 14px; font-weight: 600; background: var(--primary-color); border: 1px solid var(--primary-color); border-radius: 6px; }
</style>
