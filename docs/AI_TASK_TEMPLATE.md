# AI 开发任务模板

```text
项目：tying-sudo/fund-app（工作目录 D:\fund-app）
目标：[业务结果]
允许修改：[文件或模块]
禁止修改：[运行时数据、生产配置、无关模块]
验收标准：[可观察行为、接口语义、数据时间规则]

先阅读 README.md、docs/AI_HANDOFF.md、docs/WORKLOG.md 和目标模块的说明文件。
先执行 git status --short --branch，保留已有修改；禁止 reset、checkout、clean、批量格式化和未授权上游同步。
不得读取、上传、回显或提交 .env、密钥、Cookie、用户数据、数据库/Redis 备份、SSH 私钥或 APK 签名材料。

实施前说明影响范围。基金数据必须检查真实响应、字段语义、北京时间/交易时段和失败降级，不得把 HTTP 200、空值或旧值当作成功。
完成后至少按影响范围运行 vue-tsc、Vite build、前端相关测试、server 测试和网格目录中的 Python 测试；报告修改文件、验证结果、未验证风险和建议提交标题。
未经明确授权不得部署、修改生产数据库、发布 APK、改版本号、修改 DNS/Nginx 或安装定时同步任务。
```

后端架构优化的首次任务应使用 `docs/AI_BACKEND_OPTIMIZATION_BRIEF.md`，先审计后实施。
