# AI 平台交接说明

## 项目边界

- 仓库：`tying-sudo/fund-app`；实际工作目录：`D:\fund-app`。
- 前端：Vue 3、TypeScript、Vite、Vant、Pinia，构建产物为 `dist/`。
- 后端：`server/` 中的 Node.js/Express `fund-proxy`，负责基金数据聚合、缓存、OCR、行情和发布元数据。
- 数据服务：PostgreSQL/Supabase 迁移和 Redis 缓存；服务端运行时数据、数据库和环境文件不进入 Git 或外部 AI 上下文。
- 网格服务：`vendor/valuation_grid/` 中的 Python/FastAPI。它是已集成的上游代码，不能作为普通前端目录随意重写或覆盖。
- 移动端：Capacitor Android。版本来源、APK、签名与发布元数据属于独立发布流程。

## 接手规则

1. 开始前运行 `git status --short --branch`，保留全部现有改动和未追踪文件。
2. 不得读取、回显、上传或提交 `.env*`、SSH 私钥、Cookie、用户持仓、数据库备份、Redis 数据、Android 签名材料或服务端运行时数据。
3. 不得执行 `git reset`、`git checkout --`、`git clean`、全库格式化或未授权的上游同步。
4. 基金数据变更必须验证真实响应、字段含义、北京时间、交易时段、异常与降级路径。HTTP 200、空数据或陈旧数据不等于正确。
5. 不得用历史净值伪装成实时估值；官方净值、同日估值、缓存快照和市场休市状态必须区分。

## 最低验证基线

```powershell
npm.cmd ci
npx.cmd vue-tsc --noEmit
npm.cmd run build
npm.cmd run test:holding
npm.cmd --prefix server test
```

网格 Python 测试必须在 `D:\fund-app\vendor\valuation_grid` 中运行。涉及 Android 时，先核对当前版本来源和发布状态，再构建；未经明确授权不得发布 APK、静态站点或后端。

## 部署边界

前端静态文件、`fund-proxy`、valuation-grid、数据库迁移和 APK 发布可以独立变更。发布任一部分前须明确其所有权、依赖服务、回滚点和公网验证项。后端或 Android 发布默认不能覆盖既有静态站点、运行时数据或并行工作树改动。

完整的后端优化首条指令见 `docs/AI_BACKEND_OPTIMIZATION_BRIEF.md`。
