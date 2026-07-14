# 基金应用开发快速启动

## 一键启动
```bash
npm run dev:all
```

这将同时启动：
- 后端API服务器 (端口3001)
- 前端开发服务器 (端口5173)

## 手动启动

如果需要分别启动前端和后端：

```bash
# 终端1: 启动后端
npm run dev:api

# 终端2: 启动前端
npm run dev
```

## 访问地址

- 前端：http://localhost:5173
- 后端API：http://localhost:3001
- API文档：http://localhost:3001/api/health

## 测试API

```bash
# 测试基金列表
curl http://localhost:3001/api/fund-list

# 测试缓存状态
curl http://localhost:3001/api/cache-stats

# 测试健康检查
curl http://localhost:3001/api/health
```

## 常见问题

**Q: 首次加载较慢？**
A: 后端正在预热缓存，首次会从东方财富API抓取全市场基金列表，大约需要10-30秒。

**Q: 如何刷新缓存？**
```bash
curl -X POST http://localhost:3001/api/cache-refresh
```

**Q: 端口冲突？**
修改 `vite.config.ts` 和 `dev-server.mjs` 中的端口配置。

## 架构说明

```
用户 → 前端(5173) → Vite代理 → 后端API(3001) → 缓存/外部API
```

优势：
- ✅ 后端处理CORS和反爬
- ✅ 智能缓存，减少重复请求
- ✅ 支持搜索和分页
- ✅ 定时自动更新数据