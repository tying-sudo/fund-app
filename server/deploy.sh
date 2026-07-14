#!/bin/bash
# tyingfund.com 部署脚本
# [WHY] 一键部署后端服务到远程服务器
# [HOW] bash server/deploy.sh

set -e

SERVER="root@tyingfund.com"
REMOTE_DIR="/opt/fund-proxy"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================="
echo "  部署 fund-proxy 到 tyingfund.com"
echo "========================================="

# 1. 创建远程目录
echo "📁 创建远程目录..."
ssh $SERVER "mkdir -p $REMOTE_DIR/data $REMOTE_DIR/logs"

# 2. 同步文件
echo "📤 同步文件..."
rsync -avz --exclude='node_modules' --exclude='data' --exclude='logs' \
  "$LOCAL_DIR/" "$SERVER:$REMOTE_DIR/"

# 3. 安装依赖
echo "📦 安装依赖..."
ssh $SERVER "cd $REMOTE_DIR && npm install --production"

# 4. 抓取数据（首次部署时）
echo "📊 检查数据文件..."
ssh $SERVER "if [ ! -f $REMOTE_DIR/data/fund-list.json ]; then
  echo '首次部署，抓取基金数据...'
  cd $REMOTE_DIR && node scrape-funds.mjs
else
  echo '数据文件已存在，跳过抓取'
fi"

# 5. 重启服务
echo "🔄 重启服务..."
ssh $SERVER "cd $REMOTE_DIR && pm2 restart fund-proxy || pm2 start ecosystem.config.cjs"

# 6. 检查状态
echo "📋 服务状态:"
ssh $SERVER "pm2 status fund-proxy"

echo ""
echo "✅ 部署完成！"
echo "🌐 访问: https://tyingfund.com/api/health"
