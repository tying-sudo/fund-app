# 基金宝

基金实时估值、持仓收益、市场行情与低频估值网格的一体化应用，支持 Web 和 Android。

[![Release](https://img.shields.io/github/v/release/tying-sudo/fund-app)](https://github.com/tying-sudo/fund-app/releases)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Vue](https://img.shields.io/badge/Vue-3.x-brightgreen.svg)
![Capacitor](https://img.shields.io/badge/Capacitor-7.x-blue.svg)

- 在线访问：[www.tyingfund.com](https://www.tyingfund.com)
- Android 下载：[GitHub Releases](https://github.com/tying-sudo/fund-app/releases)
- 当前版本：`1.0.58 (59)`

## 主要功能

- **基金估值与走势**：展示盘中估值、官方净值、历史走势和阶段收益，区分实时、结算与缓存数据。
- **自选与持仓**：管理自选基金、持仓成本、份额和收益，支持图片识别导入与持仓数据保护。
- **市场行情**：提供境内、港股、美股及全球指数看板，以及行业、概念板块资金和趋势视图。
- **低频估值网格**：集成估值网格策略、信号排序、交易导入和回测相关能力。
- **Android 更新**：Capacitor 客户端支持远程版本检查和 APK 更新。
- **服务端能力**：包含基金数据聚合、缓存、OCR、行情持久化、数据库迁移及部署脚本。

## 技术架构

| 模块 | 技术 |
| --- | --- |
| 前端 | Vue 3、TypeScript、Vite、Vant、Pinia |
| 图表 | Canvas API、lightweight-charts、D3 Force |
| 后端 | Node.js、Express |
| Android | Capacitor 7 |
| 网格服务 | Python、FastAPI |
| 数据持久化 | Supabase/PostgreSQL、服务端缓存 |

## 快速开始

### 前端

```bash
git clone https://github.com/tying-sudo/fund-app.git
cd fund-app
npm ci
npm run dev
```

生产构建：

```bash
npm run build
```

### 后端

```bash
cd server
npm ci
npm start
```

服务端密钥和连接信息必须通过环境变量提供，不要写入源码、前端资源或 APK。

### Android

Android 构建需要 JDK 21 和已配置的 Android SDK：

```bash
npm run cap:sync
cd android
./gradlew assembleDebug
```

APK 输出位置为 `android/app/build/outputs/apk/debug/app-debug.apk`。

## 测试

```bash
npm run test:holding
npm run test:grid-trade-import
npm run test:grid-strategy-order
npm run build

cd server
npm test
```

## 数据说明

本项目聚合公开的基金、指数和板块信息，并使用官方快照、实时估值及本地缓存处理不同交易时段。数据可能延迟或中断，仅供学习和个人研究，不构成投资建议；基金净值以基金公司最终公告为准。

## 来源与致谢

- 应用早期结构和文档源自 [`xiriovo/fund-app`](https://github.com/xiriovo/fund-app)；该历史地址在 2026-07-22 核验时已不可公开访问，本仓库在其基础上持续维护。
- 低频估值网格模块基于 [`shangjinma-source/valuation_grid`](https://github.com/shangjinma-source/valuation_grid)，本仓库在 `vendor/valuation_grid` 中保留集成代码，并对界面、持仓保护、交易导入和部署流程进行了适配。

感谢上述项目及所有贡献者。本仓库的二次开发内容依据 [MIT License](./LICENSE) 发布；引用上游代码时同时遵守对应源仓库的许可要求。

## 贡献

欢迎通过当前仓库的 [Issues](https://github.com/tying-sudo/fund-app/issues) 和 Pull Requests 提交问题或改进。
