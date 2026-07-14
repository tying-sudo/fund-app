<script setup lang="ts">
// [WHY] 搜索页 - 搜索基金并添加到自选
// [WHAT] 输入基金代码或名称搜索，点击添加到自选

import { ref, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useFundStore } from '@/stores/fund'
import { searchFund } from '@/api/fund'
import { showToast, showLoadingToast, closeToast } from 'vant'
import type { FundInfo } from '@/types/fund'

const router = useRouter()
const route = useRoute()
const fundStore = useFundStore()

const keyword = ref('')

// [WHY] 从路由参数获取初始搜索关键词
onMounted(() => {
  const q = route.query.q as string
  if (q) {
    keyword.value = q
    doSearch(q)
  }
})
const searchResults = ref<FundInfo[]>([])
const isSearching = ref(false)

// [WHAT] 防抖搜索 - 输入停止 300ms 后触发
let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(keyword, (val) => {
  if (searchTimer) {
    clearTimeout(searchTimer)
  }
  
  if (!val.trim()) {
    searchResults.value = []
    return
  }
  
  searchTimer = setTimeout(() => {
    doSearch(val)
  }, 300)
})

// [WHAT] 执行搜索
async function doSearch(kw: string) {
  if (!kw.trim()) return
  
  isSearching.value = true
  try {
    const results = await searchFund(kw, 30)
    searchResults.value = results
  } catch (err) {
    showToast('搜索失败')
  } finally {
    isSearching.value = false
  }
}

// [WHAT] 添加基金到自选
async function handleAdd(fund: FundInfo) {
  if (fundStore.isFundInWatchlist(fund.code)) {
    showToast('已在自选中')
    return
  }
  
  showLoadingToast({ message: '添加中...', forbidClick: true })
  
  try {
    await fundStore.addFund(fund.code, fund.name)
    closeToast()
    showToast('添加成功')
  } catch {
    closeToast()
    showToast('添加失败')
  }
}

// [WHAT] 返回上一页
function goBack() {
  router.back()
}

// [WHAT] 判断基金是否已在自选中
function isInWatchlist(code: string): boolean {
  return fundStore.isFundInWatchlist(code)
}
</script>

<template>
  <div class="search-page">
    <!-- 搜索栏 -->
    <van-nav-bar title="搜索基金" left-arrow @click-left="goBack">
      <template #right>
        <span v-if="isSearching" class="searching-text">搜索中...</span>
      </template>
    </van-nav-bar>

    <!-- 搜索输入框 -->
    <van-search
      v-model="keyword"
      placeholder="输入基金代码或名称"
      show-action
      autofocus
      @cancel="goBack"
    />

    <!-- 搜索结果列表 -->
    <div class="search-results">
      <van-cell
        v-for="fund in searchResults"
        :key="fund.code"
        :title="fund.name"
        :label="`${fund.code} · ${fund.type}`"
        clickable
        @click="handleAdd(fund)"
      >
        <template #right-icon>
          <van-tag v-if="isInWatchlist(fund.code)" type="success">已添加</van-tag>
          <van-icon v-else name="add-o" size="20" color="#1989fa" />
        </template>
      </van-cell>

      <!-- 空状态 -->
      <van-empty
        v-if="keyword && searchResults.length === 0 && !isSearching"
        image="search"
        description="未找到相关基金"
      />

      <!-- 搜索提示 -->
      <div v-if="!keyword" class="search-tip">
        <van-icon name="info-o" />
        <span>输入基金代码（如 001186）或名称搜索</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-page {
  min-height: 100vh;
  background: var(--bg-primary);
  transition: background-color 0.3s;
}

.searching-text {
  font-size: 12px;
  color: var(--text-secondary);
}

.search-results {
  background: var(--bg-secondary);
}

.search-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  color: var(--text-secondary);
  font-size: 14px;
}
</style>
