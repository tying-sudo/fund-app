# 贡献指南

感谢你对基金宝的关注！我们欢迎任何形式的贡献。

## 贡献方式

### 报告问题

如果你发现了 Bug 或有功能建议：

1. 在 [Issues](https://github.com/xiriovo/fund-app/issues) 中搜索是否已有相关问题
2. 如果没有，创建新的 Issue
3. 详细描述问题或建议，最好附带截图或复现步骤

### 提交代码

1. Fork 本仓库
2. 创建特性分支

```bash
git checkout -b feature/amazing-feature
```

3. 进行修改并提交

```bash
git commit -m 'Add amazing feature'
```

4. 推送到你的仓库

```bash
git push origin feature/amazing-feature
```

5. 创建 Pull Request

## 代码规范

### 命名规范

- 文件名：小写字母，多单词用 `-` 连接
- 组件名：PascalCase
- 变量名：camelCase
- 常量：UPPER_SNAKE_CASE

### 注释规范

所有关键代码必须添加注释，格式如下：

```typescript
// [WHY] 为什么需要这段代码？
// [WHAT] 这段代码做了什么？
// [HOW] 关键实现细节
// [EDGE] 边界情况
// [DEPS] 依赖关系
```

### 提交规范

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 新功能
fix: 修复 Bug
docs: 文档更新
style: 代码格式
refactor: 重构
test: 测试
chore: 构建/工具
```

示例：

```bash
git commit -m "feat: 添加基金经理排行功能"
git commit -m "fix: 修复 K 线图空数据问题"
```

## 开发流程

1. 确保本地开发环境正常
2. 创建分支进行开发
3. 编写/修改代码
4. 本地测试通过
5. 提交 Pull Request
6. 等待代码审查
7. 合并到主分支

## 需要帮助？

- 查看 [开发文档](/dev/setup)
- 在 [Discussions](https://github.com/xiriovo/fund-app/discussions) 提问
- 联系维护者

再次感谢你的贡献！🎉
