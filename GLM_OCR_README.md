# 基金APP - 智谱GLM-OCR AI识别功能

## 🎯 功能说明

已在导入图标上添加**二级菜单**，支持两种识别方式：

### 1. 本地OCR识别（默认）
- **技术**: Tesseract.js v5
- **优点**: 无需网络，完全本地处理
- **缺点**: 中文识别准确率较低（约10-30%）
- **适用场景**: 离线环境、快速预览

### 2. AI智能识别（新增✨）
- **技术**: 智谱GLM-OCR (0.9B参数专业OCR模型)
- **优点**: 
  - 中文识别准确率极高（>95%）
  - 支持复杂表格、手写体、印章等
  - 智能结构化输出（Markdown/JSON）
- **缺点**: 需要联网、消耗API额度
- **价格**: 0.2元/百万Token（1元可处理~2000张图片）

---

## 🚀 使用方法

### 第一步：配置API Key

编辑 `fund-app/.env.local` 文件：

```bash
# 智谱AI GLM-OCR API 配置
VITE_ZHIPU_API_KEY=你的智谱API密钥
```

**获取API Key：**
1. 访问 [智谱AI开放平台](https://open.bigmodel.cn/)
2. 注册/登录账号
3. 进入控制台 → API Keys → 创建新Key
4. 复制API Key到配置文件

### 第二步：启动应用

```bash
cd fund-app
npm run dev:all
# 或
npm run dev
```

### 第三步：使用AI识别

1. 打开持仓页面
2. 点击右上角的 **📷 导入图标**
3. 在弹出的二级菜单中选择：
   - **"📷 本地OCR识别"** - 使用Tesseract.js
   - **"🚀 AI智能识别"** - 使用智谱GLM-OCR ⭐推荐
4. 选择支付宝截图/照片
5. 点击 **"开始识别"** 按钮
6. 查看识别结果，勾选需要导入的基金
7. 点击 **"导入选中的基金"**

---

## 📸 UI界面说明

### 二级菜单样式
```
┌─────────────────────┐
│ 📷                  │ ← 导入图标（点击展开菜单）
│ ┌─────────────────┐ │
│ │📷 本地OCR识别   │ │
│ │  使用Tesseract  │ │
│ │              ✓  │ │ ← 当前选中项显示蓝色对勾
│ ├─────────────────┤ │
│ │🔥 AI智能识别    │ │
│ │  使用智谱GLM-OCR│ │
│ └─────────────────┘ │
└─────────────────────┘
```

### 识别按钮动态显示
- 选择"本地OCR": 按钮显示 `📷 本地OCR识别`
- 选择"AI智能识别": 按钮显示 `🚀 AI智能识别`

---

## 🔧 技术实现细节

### 核心文件
- **主文件**: `fund-app/src/views/Holding.vue`
- **配置文件**: `fund-app/.env.local`
- **新增函数**:
  - `triggerOcrMenu()` - 触发二级菜单
  - `selectOcrMode(mode)` - 选择OCR模式
  - `startAiOcrImport()` - 调用智谱GLM-OCR API
  - `fileToBase64(file)` - 图片转Base64工具
  - `processOcrText(text)` - OCR文本解析公共函数
  - `processFoundCodes()` - 基金信息提取核心逻辑

### API调用流程
```
用户选择图片 → 转Base64 → POST请求智谱API → 解析响应 → 提取基金列表
     ↓                ↓           ↓              ↓          ↓
  handleImage    fileToBase64  fetch()        processOcrText  confirmImportFunds
   Selected()                                             
```

### 智谱API请求格式
```javascript
POST https://open.bigmodel.cn/api/paas/v4/layout_parsing
Headers:
  Content-Type: application/json
  Authorization: {你的API_Key}

Body:
{
  "model": "glm-ocr",
  "file": "data:image/jpeg;base64,{Base64编码的图片}"
}
```

### 响应格式示例
```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "content": "识别出的文本内容...",
    "markdown": "# 结构化Markdown格式...",
    // 或其他格式
  }
}
```

---

## 💡 使用建议

### 推荐使用AI识别的场景
- ✅ 支付宝/微信基金截图（中文密集）
- ✅ 包含复杂表格的持仓报告
- ✅ 手写笔记或盖章文档
- ✅ 需要高精度识别的关键操作

### 可使用本地OCR的场景
- ✅ 快速测试或预览
- ✅ 网络不稳定的环境
- ✅ 简单英文内容
- ✅ 不想消耗API额度时

### 提升识别率的技巧
1. **图片清晰度**: 截图分辨率≥1080P
2. **光线充足**: 避免阴影和反光
3. **完整截图**: 确保包含完整的6位基金代码
4. **避免遮挡**: 不要有弹窗或通知遮挡关键信息

---

## ❓ 常见问题

### Q1: 提示"请先配置智谱API Key"
**A:** 编辑 `.env.local` 文件，填入有效的智谱API Key。参考上方"第一步"。

### Q2: AI识别失败提示"API请求失败: 401"
**A:** API Key无效或过期，请检查控制台的Key状态。

### Q3: AI识别速度较慢？
**A:** 正常现象。GLM-OCR处理一张图片约需1-2秒（取决于图片大小和网络）。

### Q4: 如何查看API调用日志？
**A:** 打开浏览器控制台（F12），搜索 `GLM-OCR` 关键词即可看到详细日志。

### Q5: API费用如何？
**A:** 
- 单价：0.2元/百万Token
- 一张普通截图约消耗0.0005-0.001元（可忽略不计）
- 新用户通常有免费额度

---

## 🔐 安全注意事项

⚠️ **重要提醒**:
1. **不要将API Key提交到Git仓库** - `.env.local` 已加入 `.gitignore`
2. **定期更换API Key** - 如怀疑泄露，立即在智谱控制台重置
3. **设置IP白名单**（可选）：在智谱控制台限制API调用来源IP

---

## 📞 技术支持

- **智谱官方文档**: https://docs.bigmodel.cn/cn/guide/models/vlm/glm-ocr
- **智谱开放平台**: https://open.bigmodel.cn/
- **问题反馈**: 请在项目Issue中提交

---

## 📝 更新日志

### 2026-07-09 (当前版本)
- ✅ 添加导入图标二级菜单
- ✅ 集成智谱GLM-OCR AI识别功能
- ✅ 支持本地OCR和AI识别模式切换
- ✅ 动态按钮文本显示当前模式
- ✅ 完整的错误处理和用户提示
- ✅ 响应式UI动画效果

---

**祝使用愉快！🎉**
