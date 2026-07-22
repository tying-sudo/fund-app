<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { showToast } from 'vant'
import { fetchMarketIndices, type MarketIndex } from '@/api/market'
import { API_BASE_URL } from '@/config/api'

const props = withDefaults(defineProps<{ variant?: 'holding' | 'market' }>(), { variant: 'market' })

const INDEX_STORAGE_KEY = 'market:index-watchlist:v1'
const DEFAULT_CODES = ['000001', '399001', '399006', 'HSTECH', '000300', '000688']
type IndexMarket = 'cn' | 'hk' | 'us' | 'global'
type MarketPhase = 'open' | 'break' | 'closed'

const indices = ref<MarketIndex[]>([])
const order = ref<string[]>([...DEFAULT_CODES])
const managerOpen = ref(false)
const loading = ref(false)
const dragging = ref<string | null>(null)
const collapsed = ref(true)
const marketPhases = ref<Record<IndexMarket, MarketPhase>>({ cn: 'closed', hk: 'closed', us: 'closed', global: 'closed' })
let marketTimer: ReturnType<typeof window.setInterval> | undefined
let quoteTimer: ReturnType<typeof window.setInterval> | undefined
let rotationTimer: ReturnType<typeof window.setInterval> | undefined
let longPressTimer: ReturnType<typeof window.setTimeout> | undefined
let stream: EventSource | undefined

const selected = computed(() => order.value.map(code => indices.value.find(item => item.code === code)).filter((item): item is MarketIndex => Boolean(item)))
const boardMarket = ref<IndexMarket>('cn')
const rotatingCode = ref<string | null>(null)
const visible = computed(() => {
  const preferred = indices.value.filter(item => item.market === boardMarket.value)
  const remaining = selected.value.filter(item => item.market !== boardMarket.value)
  return [...preferred, ...remaining]
})
const collapsedLimit = computed(() => props.variant === 'holding' ? 6 : 8)
const displayed = computed(() => collapsed.value ? visible.value.slice(0, collapsedLimit.value) : visible.value)
const rotatingIndex = computed(() => visible.value.find(item => item.code === rotatingCode.value) || visible.value[0])
const available = computed(() => indices.value.filter(item => !order.value.includes(item.code)))
const marketStatus = ref('休市')

function persist() { localStorage.setItem(INDEX_STORAGE_KEY, JSON.stringify(order.value)) }
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(INDEX_STORAGE_KEY) || '[]')
    if (Array.isArray(saved) && saved.every(code => typeof code === 'string')) order.value = saved
  } catch { /* Keep defaults. */ }
}
function changeClass(value: number) { return value > 0 ? 'up' : value < 0 ? 'down' : 'flat' }
function price(value: number) { return Number.isFinite(value) ? value.toFixed(2) : '--' }
function change(item: MarketIndex) { return `${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}  ${item.changePercent >= 0 ? '+' : ''}${item.changePercent.toFixed(2)}%` }
function marketTag(item: MarketIndex) {
  const phase = marketPhases.value[item.market]
  return phase === 'open' ? '开盘' : phase === 'break' ? '盘中休市' : '休市'
}
function add(code: string) {
  if (order.value.includes(code)) return
  order.value.push(code); persist()
}
function remove(code: string) {
  if (order.value.length <= 1) return showToast('至少保留 1 个指数')
  order.value = order.value.filter(item => item !== code); persist()
}
function move(source: string, target: string) {
  const from = order.value.indexOf(source); const to = order.value.indexOf(target)
  if (from < 0 || to < 0 || from === to) return
  const next = [...order.value]; next.splice(from, 1); next.splice(to, 0, source); order.value = next; persist()
}
function syncActiveMarketOrder() {
  if (indices.value.length === 0) return
  const activeCodes = indices.value.filter(item => item.market === boardMarket.value).map(item => item.code)
  const activeSet = new Set(activeCodes)
  const next = [...activeCodes, ...order.value.filter(code => !activeSet.has(code))]
  if (next.length === order.value.length && next.every((code, index) => code === order.value[index])) return
  order.value = next
  persist()
}
function openManager() {
  syncActiveMarketOrder()
  managerOpen.value = true
}
function clearLongPress() {
  if (longPressTimer) window.clearTimeout(longPressTimer)
  longPressTimer = undefined
}
function startLongPress(code: string, event: PointerEvent) {
  if (event.pointerType !== 'touch') return
  clearLongPress()
  longPressTimer = window.setTimeout(() => { dragging.value = code; navigator.vibrate?.(20) }, 360)
}
function moveLongPress(event: PointerEvent) {
  if (!dragging.value || event.pointerType !== 'touch') return
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-index-code]')?.dataset.indexCode
  if (target) move(dragging.value, target)
}
function endLongPress() { clearLongPress(); dragging.value = null }
function reset() { order.value = [...DEFAULT_CODES]; persist() }
function refresh() { return load() }
function rotateSummary() {
  const items = visible.value
  if (!items.length) {
    rotatingCode.value = null
    return
  }
  const currentIndex = items.findIndex(item => item.code === rotatingCode.value)
  rotatingCode.value = items[(currentIndex < 0 ? 1 : currentIndex + 1) % items.length].code
}
async function load() {
  if (loading.value) return
  loading.value = true
  try { indices.value = await fetchMarketIndices(); syncActiveMarketOrder() }
  catch (error) { showToast(error instanceof Error ? error.message : '指数加载失败') }
  finally { loading.value = false }
}

defineExpose({ refresh })
function startQuoteStream() {
  if (!('EventSource' in window)) {
    quoteTimer = window.setInterval(load, 2_000)
    return
  }
  stream = new EventSource(`${API_BASE_URL}/api/market-index-stream`)
  stream.addEventListener('indices', (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data)
      if (Array.isArray(payload.indices)) { indices.value = payload.indices; syncActiveMarketOrder() }
    } catch { /* Retain the last valid quote frame. */ }
  })
  stream.onerror = () => {
    stream?.close()
    stream = undefined
    if (!quoteTimer) quoteTimer = window.setInterval(load, 2_000)
  }
}
function updateMarketStatus() {
  const now = new Date()
  const clock = (timeZone: string) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).filter(item => item.type !== 'literal').map(item => [item.type, item.value]))
    return { weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) }
  }
  const cn = clock('Asia/Shanghai'); const hk = clock('Asia/Hong_Kong'); const us = clock('America/New_York')
  const cnOpen = cn.weekday && ((cn.minutes >= 570 && cn.minutes < 690) || (cn.minutes >= 780 && cn.minutes < 900))
  const hkOpen = hk.weekday && ((hk.minutes >= 570 && hk.minutes < 720) || (hk.minutes >= 780 && hk.minutes < 960))
  const usOpen = us.weekday && us.minutes >= 570 && us.minutes < 960
  marketPhases.value = {
    cn: cnOpen ? 'open' : cn.weekday && cn.minutes >= 690 && cn.minutes < 780 ? 'break' : 'closed',
    hk: hkOpen ? 'open' : hk.weekday && hk.minutes >= 720 && hk.minutes < 780 ? 'break' : 'closed',
    us: usOpen ? 'open' : 'closed',
    global: 'closed'
  }
  const closedMarket: IndexMarket = us.weekday && us.minutes >= 960
    ? 'us'
    : hk.weekday && hk.minutes >= 960
      ? 'hk'
      : cn.weekday && cn.minutes >= 900
        ? 'cn'
        : cn.minutes < 570
          ? 'us'
          : 'cn'
  const nextMarket: IndexMarket = cnOpen ? 'cn' : hkOpen ? 'hk' : usOpen ? 'us' : closedMarket
  const changed = boardMarket.value !== nextMarket
  boardMarket.value = nextMarket
  syncActiveMarketOrder()
  if (cnOpen) marketStatus.value = 'A股盘中'
  else if (hkOpen) marketStatus.value = '港股盘中'
  else if (usOpen) marketStatus.value = '美股盘中'
  else marketStatus.value = `${nextMarket === 'hk' ? '港股' : nextMarket === 'us' ? '美股' : 'A股'}收盘快照`
  if (changed) void load()
}
onMounted(() => {
  restore(); updateMarketStatus(); void load()
  marketTimer = window.setInterval(updateMarketStatus, 60_000)
  rotationTimer = window.setInterval(rotateSummary, 1_500)
  startQuoteStream()
})
onBeforeUnmount(() => {
  if (marketTimer) window.clearInterval(marketTimer)
  if (quoteTimer) window.clearInterval(quoteTimer)
  if (rotationTimer) window.clearInterval(rotationTimer)
  stream?.close()
})
</script>

<template>
  <section :class="['index-board', `index-board-${props.variant}`]" aria-label="指数看板">
    <div class="index-board-head">
      <div class="index-board-summary">
        <strong>{{ rotatingIndex?.name || '指数看板' }}</strong>
        <b v-if="rotatingIndex" :class="changeClass(rotatingIndex.changePercent)">{{ price(rotatingIndex.price) }}</b>
        <span v-if="rotatingIndex" :class="changeClass(rotatingIndex.changePercent)">{{ change(rotatingIndex) }}</span>
      </div>
      <div class="index-board-actions">
        <button type="button" :title="collapsed ? '展开全部指数' : '收起指数列表'" @click="collapsed = !collapsed"><van-icon :name="collapsed ? 'arrow-down' : 'arrow-up'" /></button>
        <button type="button" title="指数个性化设置" @click="openManager"><van-icon name="setting-o" /></button>
      </div>
    </div>
    <div v-if="loading && !visible.length" class="index-board-grid"><i v-for="item in collapsedLimit" :key="item" /></div>
    <div v-else class="index-board-grid">
      <article v-for="item in displayed" :key="item.code">
        <span><small :class="['market-tag', marketPhases[item.market]]">{{ marketTag(item) }}</small>{{ item.name }}</span><b :class="changeClass(item.changePercent)">{{ price(item.price) }}</b><em :class="changeClass(item.changePercent)">{{ change(item) }}</em>
      </article>
    </div>
  </section>

  <van-popup v-model:show="managerOpen" position="bottom" class="index-board-manager" :safe-area-inset-bottom="true">
    <div class="manager-handle"></div>
    <header><div><h2><van-icon name="setting-o" /> 指数个性化设置</h2><p>拖动卡片即可排序</p></div><button type="button" title="关闭" @click="managerOpen = false"><van-icon name="cross" /></button></header>
    <div class="manager-body">
      <section><div class="manager-label"><span>已添加指数</span><button type="button" @click="reset">恢复默认</button></div>
        <div class="manager-selected">
          <article v-for="code in order" :key="code" :data-index-code="code" draggable="true" :class="{ dragging: dragging === code }" @dragstart="dragging = code" @dragover.prevent @drop.prevent="dragging && move(dragging, code)" @dragend="endLongPress" @pointerdown="startLongPress(code, $event)" @pointermove="moveLongPress" @pointerup="endLongPress" @pointercancel="endLongPress">
            <template v-if="indices.find(item => item.code === code)"><span>{{ indices.find(item => item.code === code)?.name }}</span><b :class="changeClass(indices.find(item => item.code === code)?.changePercent || 0)">{{ price(indices.find(item => item.code === code)?.price || 0) }}</b><button type="button" title="移除" @click="remove(code)"><van-icon name="minus" /></button></template>
          </article>
        </div>
      </section>
      <section><div class="manager-label"><span>点击可选指数</span><button type="button" title="刷新指数" @click="refresh"><van-icon name="replay" :class="{ spinning: loading }" /></button></div>
        <div class="manager-options"><button v-for="item in available" :key="item.code" type="button" @click="add(item.code)">{{ item.name }}</button></div>
      </section>
    </div>
  </van-popup>
</template>

<style scoped>
.index-board { overflow: hidden; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); box-shadow: 0 6px 18px rgba(0,0,0,.05); }
.index-board-head { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:38px; padding:0 11px; border-bottom:1px solid var(--border-color); }
.index-board-summary { display:flex; min-width:0; align-items:baseline; gap:8px; overflow:hidden; white-space:nowrap; }.index-board-summary strong { overflow:hidden; color:var(--text-primary); font-size:13px; text-overflow:ellipsis; }.index-board-summary small { flex:0 0 auto; color:var(--text-secondary); font-size:10px; }.index-board-summary b,.index-board-summary span { flex:0 0 auto; font-size:12px; font-variant-numeric:tabular-nums; }.index-board-summary b { font-weight:700; }
.index-board-actions { display:flex; flex:0 0 auto; }.index-board-actions button,.index-board-manager header button,.manager-label button,.manager-selected button { display:grid; width:29px; height:29px; place-items:center; border:0; border-radius:4px; color:var(--text-secondary); background:transparent; cursor:pointer; }.index-board-actions button:active { background:var(--bg-tertiary); }
.index-board-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(102px,1fr)); gap:7px; padding:8px; }.index-board-grid article,.index-board-grid i { display:grid; min-width:0; min-height:60px; align-content:start; gap:4px; padding:7px; border:1px solid var(--border-color); border-radius:7px; background:var(--bg-primary); }.index-board-grid i { background:var(--bg-tertiary); }.index-board-grid span { overflow:hidden; color:var(--text-secondary); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }.index-board-grid span small { display:inline-flex; margin-right:4px; padding:1px 3px; border-radius:3px; font-size:9px; font-style:normal; line-height:1.2; }.market-tag.open { color:var(--color-up); background:color-mix(in srgb,var(--color-up) 12%,transparent); }.market-tag.break { color:#d97706; background:rgba(217,119,6,.12); }.market-tag.closed { color:var(--text-secondary); background:var(--bg-tertiary); }.index-board-grid b { overflow:hidden; font-size:14px; font-variant-numeric:tabular-nums; text-overflow:ellipsis; white-space:nowrap; }.index-board-grid em { overflow:hidden; font-size:10px; font-style:normal; font-variant-numeric:tabular-nums; text-overflow:ellipsis; white-space:nowrap; }
.index-board-market .index-board-grid { grid-template-columns:repeat(4,minmax(0,1fr)); gap:5px; padding:6px; }.index-board-market .index-board-grid article,.index-board-market .index-board-grid i { min-height:55px; padding:6px; }.index-board-market .index-board-grid b { font-size:12px; }
.index-board-holding .index-board-grid { grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; padding:7px; }.index-board-holding .index-board-grid article,.index-board-holding .index-board-grid i { min-height:58px; padding:7px; }.index-board-holding .index-board-grid b { font-size:13px; }
.up { color:var(--color-up); }.down { color:var(--color-down); }.flat { color:var(--text-secondary); }.spinning { animation:spin .8s linear infinite; } @keyframes spin { to { transform:rotate(360deg); } }
.index-board-manager { display:flex; width:min(100%,560px); height:min(88dvh,720px); max-height:88dvh; flex-direction:column; overflow:hidden; border-radius:10px 10px 0 0; background:var(--bg-primary); }.manager-handle { width:40px; height:4px; flex:0 0 auto; margin:9px auto 2px; border-radius:4px; background:var(--border-color); }.index-board-manager header { display:flex; flex:0 0 auto; align-items:flex-start; justify-content:space-between; padding:10px 15px; border-bottom:1px solid var(--border-color); }.index-board-manager h2 { display:flex; gap:7px; margin:0; color:var(--text-primary); font-size:16px; }.index-board-manager p { margin:4px 0 0; color:var(--text-secondary); font-size:11px; }.manager-body { min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; }.index-board-manager section { padding:13px 15px; border-bottom:1px solid var(--border-color); }.manager-label { display:flex; align-items:center; justify-content:space-between; margin-bottom:9px; color:var(--text-primary); font-size:12px; font-weight:600; }.manager-label button { width:auto; padding:0 5px; color:var(--color-primary); font-size:11px; }.manager-selected { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }.manager-selected article { position:relative; min-width:0; min-height:68px; padding:8px; border:1px solid var(--border-color); border-radius:7px; background:var(--bg-secondary); cursor:grab; touch-action:none; }.manager-selected article.dragging { opacity:.6; outline:1px solid var(--color-primary); }.manager-selected span,.manager-selected b { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.manager-selected span { color:var(--text-secondary); font-size:10px; }.manager-selected b { margin-top:6px; font-size:13px; font-variant-numeric:tabular-nums; }.manager-selected button { position:absolute; top:3px; right:3px; width:23px; height:23px; color:#dc2626; }.manager-options { display:flex; flex-wrap:wrap; gap:7px; padding-bottom:calc(12px + env(safe-area-inset-bottom)); }.manager-options button { min-height:29px; padding:0 10px; border:1px solid var(--border-color); border-radius:15px; color:var(--text-secondary); background:var(--bg-secondary); font-size:11px; cursor:pointer; }
</style>
