# 下载安装

## Android APK

### 最新版本

<div class="download-card">
  <div class="version-info">
    <h3>v1.0.0</h3>
    <span class="release-date">2026-01-31</span>
  </div>
  <a href="https://github.com/xiriovo/fund-app/releases/latest/download/app-release.apk" class="download-btn">
    下载 APK (约 5MB)
  </a>
</div>

### 安装说明

1. 点击上方按钮下载 APK 文件
2. 在手机上打开 APK 文件
3. 如果提示"未知来源"，请在设置中允许安装
4. 安装完成后打开应用即可使用

::: tip 提示
首次安装可能需要允许"安装未知应用"权限，这是 Android 系统的安全机制。
:::

## 历史版本

| 版本 | 发布日期 | 下载 |
|------|----------|------|
| v1.0.0 | 2026-01-31 | [下载](https://github.com/xiriovo/fund-app/releases/tag/v1.0.0) |

## 自行构建

如果你是开发者，可以自行构建：

```bash
# 克隆项目
git clone https://github.com/xiriovo/fund-app.git
cd fund-app

# 安装依赖
npm install

# 构建 Web 版
npm run build

# 构建 Android APK（需要 Android SDK 和 JDK 21）
npm run cap:sync
cd android
./gradlew assembleRelease
```

<style>
.download-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px;
  background: var(--vp-c-bg-soft);
  border-radius: 12px;
  margin: 24px 0;
}

.version-info h3 {
  margin: 0 0 4px;
  font-size: 24px;
}

.release-date {
  color: var(--vp-c-text-2);
  font-size: 14px;
}

.download-btn {
  display: inline-block;
  padding: 12px 24px;
  background: var(--vp-c-brand-1);
  color: white;
  border-radius: 8px;
  font-weight: 500;
  text-decoration: none;
  transition: background 0.2s;
}

.download-btn:hover {
  background: var(--vp-c-brand-2);
}
</style>
