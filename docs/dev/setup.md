# 本地开发

## 环境要求

- Node.js 18+
- npm 或 pnpm
- Git

如需构建 Android APK，还需要：
- JDK 21
- Android SDK（Build Tools 36+）

## 克隆项目

```bash
git clone https://github.com/xiriovo/fund-app.git
cd fund-app
```

## 安装依赖

```bash
npm install
```

## 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:5173 查看应用。

## 构建生产版本

```bash
npm run build
```

构建产物在 `dist` 目录。

## 构建 Android APK

### 1. 配置环境变量

```powershell
# Windows PowerShell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.x.x-hotspot"
$env:ANDROID_HOME = "D:\androidSDK"
```

### 2. 同步 Capacitor

```bash
npm run cap:sync
```

### 3. 构建 APK

```bash
cd android
./gradlew assembleDebug
```

APK 输出位置：`android/app/build/outputs/apk/debug/app-debug.apk`

### 4. 构建 Release 版本

```bash
./gradlew assembleRelease
```

::: warning 注意
Release 版本需要配置签名密钥，参考 [Android 签名文档](https://developer.android.com/studio/publish/app-signing)。
:::

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 构建生产版本 |
| `npm run preview` | 预览构建结果 |
| `npm run cap:sync` | 同步 Capacitor |
| `npm run cap:add:android` | 添加 Android 平台 |

## 项目脚本

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc -b && vite build",
    "preview": "vite preview",
    "cap:sync": "npm run build && npx cap sync",
    "cap:add:android": "npx cap add android"
  }
}
```
