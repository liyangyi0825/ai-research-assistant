#!/bin/bash
# 一键部署脚本
# set -e：任何步骤失败立刻退出，build 失败时 pm2 restart 不会执行

set -e

PROJECT_DIR="/var/www/ai-research-assistant"

echo ""
echo "========================================="
echo "  开始部署 ai-research-assistant"
echo "========================================="

echo ""
echo "---> [1/5] 进入项目目录"
cd "$PROJECT_DIR"

echo ""
echo "---> [2/5] 同步最新代码（丢弃服务器本地改动，强制对齐远端）"
# fetch 不合并；reset --hard 丢弃所有本地修改（含 package-lock.json）再对齐远端
# 服务器永远不应该有手动改动，所以 --hard 是安全的
git fetch origin main
git reset --hard origin/main

echo ""
echo "---> [3/5] 安装依赖（npm ci：只读 lockfile，不写 package-lock.json）"
# npm ci 专为 CI/CD 设计：严格按 package-lock.json 安装，不会修改它
# 避免 npm install 因平台/版本差异重写 lockfile 导致下次 pull 失败
npm ci

echo ""
echo "---> [4/5] 删除旧构建产物，重新构建"
rm -rf .next
npm run build

echo ""
echo "---> [5/5] 构建成功，重启 PM2"
pm2 restart ai-research

echo ""
echo "========================================="
echo "  部署完成！当前进程状态："
echo "========================================="
pm2 status
