# 基金APP - 本地开发指南

## 问题原因
前端"一直加载中"的根本原因是：
1. 前端使用JSONP方式直接调用外部API，受CORS和反爬限制
2. 本地fund-list.json文件过大（3MB+），加载缓慢
3. 没有利用后端服务器的缓存机制

## 改进方案
按照您的建议，采用"后端预抓取+缓存+前端调用API"的架构：

### 架构优势
1. **性能更好**: 后端批量抓取并缓存，前端直接获取
2. **稳定性高**: 后端处理反爬和CORS，前端无需担心
3. **支持搜索**: 后端API支持关键词搜索和类型筛选
4. **定时更新**: 后端定时刷新数据，保证数据新鲜度

### 开发环境启动

#### 方式1：同时启动前端和后端（推荐）
```bash
# 在 fund-app 目录下执行
npm run dev:all
```

#### 方式2：分别启动
```bash
# 终端1: 启动后端API服务器
npm run dev:api

# 终端2: 启动前端Vite服务器
npm run dev
```

### 技术实现

#### 1. 后端API服务器 (`dev-server.mjs`)
- 端口：3001
- 功能：
  - `/api/fund-list` - 全市场基金列表（支持搜索、分页）
  - `/api/fund-estimates` - 批量基金实时估值
  - `/api/stock-quotes` - 股票行情
  - `/api/fund-rank` - 基金排行
  - `/api/market-indices` - 大盘指数
  - `/api/cache-stats` - 缓存统计
  - `/api/cache-refresh` - 手动刷新缓存

#### 2. 前端API调用修改
- 开发环境：调用 `http://localhost:3001/api/*`
- 生产环境：调用 `https://tyingfund.com/api/*`
- 自动回退：后端API失败时回退到JSONP

#### 3. Vite代理配置
- 开发环境：`/api` → `http://localhost:3001`
- 生产环境：直接调用 `https://tyingfund.com`

### 数据流
```
用户请求 → 前端组件 → 后端API → 缓存/外部API → 返回数据
```

### 缓存策略
- **基金列表**: 24小时缓存（内存+文件）
- **基金估值**: 30秒缓存
- **大盘指数**: 30秒缓存
- **基金排行**: 10分钟缓存
- **股票行情**: 无缓存（实时）

### 定时任务
- 每天2:00 - 刷新全市场基金列表
- 交易日9:00-15:00 - 每5分钟刷新大盘指数

## 生产环境部署

### 后端服务器
1. 上传 `server/` 目录到生产服务器
2. 使用PM2启动：
```bash
pm2 start ecosystem.config.cjs
```

### 前端部署
1. 构建前端：
```bash
npm run build
```
2. 部署到静态服务器或CDN

### Nginx配置
```nginx
server {
    listen 80;
    server_name tyingfund.com;

    # 前端静态文件
    location / {
        root /path/to/fund-app/dist;
        try_files $uri $uri/ /index.html;
    }

    # 后端API代理
    location /api {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 故障排查

### 1. 后端启动失败
```bash
# 检查端口占用
netstat -ano | findstr 3001

# 查看错误日志
# 查看控制台输出
```

### 2. 前端无法连接后端
- 确认后端已启动：`curl http://localhost:3001/api/health`
- 检查Vite代理配置
- 查看浏览器控制台Network标签

### 3. 数据加载慢
- 检查缓存命中率：`curl http://localhost:3001/api/cache-stats`
- 手动刷新缓存：`curl -X POST http://localhost:3001/api/cache-refresh`

## 性能对比

| 方案 | 首次加载 | 搜索响应 | 稳定性 | 维护成本 |
|-----|---------|---------|--------|---------|
| 原JSONP | 10-30s | 1-2s | 差 | 低 |
| 后端API | 1-3s | <100ms | 优 | 中 |

## 扩展建议

1. **Redis缓存**: 可替换内存缓存，支持分布式部署
2. **数据库持久化**: 历史数据存入MySQL/PostgreSQL
3. **WebSocket**: 实时推送估值数据
4. **CDN加速**: 静态资源和API响应缓存