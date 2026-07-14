#!/usr/bin/env python3
"""Patch Analysis.vue: add finance news section"""
import os

filepath = os.path.join(os.path.dirname(__file__), 'src', 'views', 'Analysis.vue')

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Replace script setup header
content = content.replace(
    '// [WHY] 分析页 - 展示资产配置和收益分析\n// [WHAT] 显示持仓分布饼图、收益统计、交易汇总、主题设置',
    '// [WHY] 分析页 - 展示资产配置、收益分析和实用工具\n// [WHAT] 显示持仓分布饼图、收益统计、交易汇总、财经资讯、主题设置'
)

# 2. Add imports
content = content.replace(
    "import { showToast } from 'vant'",
    "import { showToast } from 'vant'\nimport { fetchFinanceNews, type NewsItem } from '@/api/tiantianApi'"
)

# 3. Add news state variables after isRefreshing
content = content.replace(
    """// [WHAT] 下拉刷新状态
const isRefreshing = ref(false)

// [WHAT] 初始化数据""",
    """// [WHAT] 下拉刷新状态
const isRefreshing = ref(false)

// [WHAT] 财经资讯
const newsList = ref<NewsItem[]>([])
const newsLoading = ref(false)
const showNewsDetail = ref(false)
const currentNews = ref<NewsItem | null>(null)

// [WHAT] 初始化数据"""
)

# 4. Add loadNews call in onMounted
content = content.replace(
    """onMounted(() => {
  holdingStore.initHoldings()
})""",
    """onMounted(() => {
  holdingStore.initHoldings()
  loadNews()
})"""
)

# 5. Replace onRefresh and add new functions
content = content.replace(
    """// [WHAT] 下拉刷新
async function onRefresh() {
  isRefreshing.value = true
  try {
    await holdingStore.refreshEstimates()
    showToast('刷新成功')
  } finally {
    isRefreshing.value = false
  }
}""",
    """// [WHAT] 加载财经资讯
async function loadNews() {
  newsLoading.value = true
  try {
    newsList.value = await fetchFinanceNews(6)
  } catch {
    // 静默失败
  } finally {
    newsLoading.value = false
  }
}

// [WHAT] 下拉刷新
async function onRefresh() {
  isRefreshing.value = true
  try {
    await Promise.all([
      holdingStore.refreshEstimates(),
      loadNews()
    ])
    showToast('刷新成功')
  } finally {
    isRefreshing.value = false
  }
}

// [WHAT] 打开资讯详情
function openNews(news: NewsItem) {
  currentNews.value = news
  showNewsDetail.value = true
}

// [WHAT] 跳转到外部链接
function openNewsUrl() {
  if (currentNews.value?.url) {
    window.open(currentNews.value.url, '_blank')
  } else {
    showToast('暂无详情链接')
  }
}"""
)

# 6. Add news tool item in tools-grid
content = content.replace(
    """        <div class="tool-item" @click="router.push('/manager-rank')">
          <van-icon name="manager-o" size="24" />
          <span>经理排行</span>
        </div>
      </div>""",
    """        <div class="tool-item" @click="router.push('/manager-rank')">
          <van-icon name="manager-o" size="24" />
          <span>经理排行</span>
        </div>
        <div class="tool-item" @click="loadNews(); showNewsDetail = true">
          <van-icon name="new-o" size="24" />
          <span>财经资讯</span>
        </div>
      </div>"""
)

# 7. Add news section before settings
content = content.replace(
    """    <!-- 设置区域 -->""",
    """    <!-- 财经资讯 -->
    <div class="section news-section">
      <div class="section-header">
        <span class="section-title">财经资讯</span>
        <span class="section-action" @click="loadNews">刷新</span>
      </div>
      <div class="news-list" v-if="!newsLoading && newsList.length > 0">
        <div 
          v-for="news in newsList" 
          :key="news.id" 
          class="news-item"
          @click="openNews(news)"
        >
          <div class="news-content">
            <div class="news-title">{{ news.title }}</div>
            <div class="news-meta">
              <span class="news-source">{{ news.source }}</span>
              <span class="news-time">{{ news.time }}</span>
            </div>
          </div>
          <van-icon name="arrow" size="14" class="news-arrow" />
        </div>
      </div>
      <div v-else-if="newsLoading" class="news-loading">
        <van-loading size="24" />
        <span>加载中...</span>
      </div>
      <van-empty v-else image="search" description="暂无资讯" />
    </div>

    <!-- 设置区域 -->"""
)

# 8. Add news detail popup before tips
content = content.replace(
    """    <!-- 投资提示 -->""",
    """    <!-- 资讯详情弹窗 -->
    <van-popup 
      v-model:show="showNewsDetail" 
      position="bottom" 
      round
      :style="{ height: '70%' }"
    >
      <div class="news-detail" v-if="currentNews">
        <div class="news-detail-header">
          <span>资讯详情</span>
          <van-icon name="cross" @click="showNewsDetail = false" />
        </div>
        <div class="news-detail-content">
          <h3 class="news-detail-title">{{ currentNews.title }}</h3>
          <div class="news-detail-meta">
            <span>{{ currentNews.source }}</span>
            <span>{{ currentNews.time }}</span>
          </div>
          <div class="news-detail-summary">
            {{ currentNews.summary || '暂无摘要内容' }}
          </div>
        </div>
        <div class="news-detail-footer" v-if="currentNews.url">
          <van-button block type="primary" @click="openNewsUrl">
            查看原文
          </van-button>
        </div>
        <div class="news-detail-footer" v-else>
          <van-button block plain @click="showNewsDetail = false">
            知道了
          </van-button>
        </div>
      </div>
    </van-popup>

    <!-- 投资提示 -->"""
)

# 9. Add news styles
content = content.replace(
    """.tool-item .van-icon {
  color: var(--color-primary);
}
</style>""",
    """.tool-item .van-icon {
  color: var(--color-primary);
}

/* 财经资讯列表 */
.news-section .news-list {
  padding: 0;
}

.news-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  transition: background 0.2s;
}

.news-item:active {
  background: var(--bg-tertiary);
}

.news-item:last-child {
  border-bottom: none;
}

.news-content {
  flex: 1;
  min-width: 0;
}

.news-title {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 6px;
}

.news-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

.news-source {
  color: var(--color-primary);
}

.news-arrow {
  flex-shrink: 0;
  color: var(--text-secondary);
  margin-left: 8px;
}

.news-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-secondary);
  font-size: 13px;
}

/* 资讯详情弹窗 */
.news-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-secondary);
}

.news-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}

.news-detail-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.news-detail-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px;
  line-height: 1.4;
}

.news-detail-meta {
  display: flex;
  gap: 12px;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.news-detail-summary {
  font-size: 15px;
  line-height: 1.8;
  color: var(--text-primary);
}

.news-detail-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}
</style>"""
)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print('Patch applied successfully')
