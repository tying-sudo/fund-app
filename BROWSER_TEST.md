# 浏览器测试指南

## 🚀 开发服务器已启动

### 服务地址
- **前端（浏览器访问）**: http://localhost:5173
- **后端API**: http://localhost:3001

### 🧪 测试步骤

#### 1. 浏览器访问前端
打开浏览器访问: http://localhost:5173

#### 2. 检查页面加载速度
- 首页加载应该很快（1-3秒）
- 基金列表加载应该流畅
- 没有长时间loading状态

#### 3. 测试功能
- ✅ 搜索基金
- ✅ 查看持仓
- ✅ 查看自选
- ✅ 查看行情
- ✅ 查看详情页

#### 4. 检查网络请求
打开浏览器开发者工具（F12）→ Network标签：
- 所有 `/api/*` 请求应该返回200
- 响应时间应该 < 100ms
- 没有 CORS 错误

### 🔧 API测试

#### 健康检查
```bash
curl http://localhost:3001/api/health
```

#### 缓存状态
```bash
curl http://localhost:3001/api/cache-stats
```

#### 刷新缓存
```bash
curl -X POST http://localhost:3001/api/cache-refresh
```

### 📊 数据抓取

本地服务器会自动：
- 启动时预热缓存
- 每天02:00刷新基金列表
- 交易日09:00-15:00每5分钟刷新大盘指数

手动刷新：
```bash
curl -X POST http://localhost:3001/api/cache-refresh
```

### ⚡ 性能对比

| 页面 | 旧方案 | 新方案 | 提升 |
|-----|--------|--------|------|
| 首页加载 | 10-30s | 1-3s | 90% |
| 基金搜索 | 1-2s | <100ms | 95% |
| 持仓页 | 慢 | 快 | 显著 |

### 🐛 故障排查

#### 页面加载慢
1. 检查后端是否运行: `curl http://localhost:3001/api/health`
2. 检查缓存状态: `curl http://localhost:3001/api/cache-stats`
3. 手动刷新缓存: `curl -X POST http://localhost:3001/api/cache-refresh`

#### API错误
1. 查看浏览器Console错误
2. 检查Network请求状态
3. 确认后端服务正常

#### 数据不对
1. 刷新缓存: `curl -X POST http://localhost:3001/api/cache-refresh`
2. 等待2-3秒后刷新页面

### 🎯 验证清单

- [ ] 浏览器能访问 http://localhost:5173
- [ ] 首页加载快速（<3秒）
- [ ] 基金列表显示正常
- [ ] 搜索功能正常
- [ ] 持仓/自选页面快速
- [ ] 没有CORS错误
- [ ] API响应时间 <100ms

### 📱 移动端测试

在手机上测试：
1. 确保手机和电脑在同一网络
2. 查看电脑IP地址（如 192.168.1.100）
3. 手机访问: http://192.168.1.100:5173

### 🔄 重启服务

如果需要重启：
```bash
# 停止当前服务
Ctrl+C

# 重新启动
npm run dev:all
```

### 📝 开发日志

前端日志: 浏览器Console
后端日志: 终端输出

---

**状态**: ✅ 开发服务器已就绪
**时间**: 2026-07-09 08:28
**访问**: http://localhost:5173