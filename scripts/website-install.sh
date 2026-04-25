#!/usr/bin/env bash
# scripts/website-install.sh
#
# Cherry Studio – Docusaurus 网站一键部署脚本（Ubuntu，HTTP 80）
#
# 用法:
#   sudo ./scripts/website-install.sh
#   sudo ./scripts/website-install.sh --domain docs.example.com
#   sudo ./scripts/website-install.sh --domain docs.example.com --user deploy
#
# 脚本功能:
#   1. 安装系统依赖（Nginx、Node.js 20、yarn）
#   2. 克隆 cherry-studio-website-docusaurus 仓库
#   3. yarn build 生成静态文件
#   4. 把 build/ 放到 /var/www/cherry-studio/
#   5. 写入 Nginx 配置，监听 80 端口
#   6. 开机自启 Nginx
#
# CI/CD 后续更新由 GitHub Actions (deploy-website.yml) 完成：
#   rsync build/ → /var/www/cherry-studio/ → nginx reload
#
# 需要在 GitHub 仓库 Secrets 中配置：
#   WEBSITE_HOST      – 服务器 IP 或域名（如 51.38.123.49）
#   WEBSITE_USER      – SSH 用户名
#   WEBSITE_SSH_KEY   – SSH 私钥（PEM 格式）

set -euo pipefail

# ─── 颜色输出 ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

log()     { echo -e "${BLUE}[website]${RESET} $*"; }
success() { echo -e "${GREEN}[website]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[website]${RESET} $*"; }
die()     { echo -e "${RED}[website]${RESET} $*" >&2; exit 1; }

# ─── 参数 ─────────────────────────────────────────────────────────────────────
DOMAIN="51.38.123.49"
DEPLOY_USER="www-data"
WEB_ROOT="/var/www/cherry-studio"
REPO_URL="https://github.com/CherryHQ/cherry-studio-website-docusaurus.git"
BUILD_DIR="/tmp/cherry-studio-website-build"
NODE_VERSION="20"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2";       shift 2 ;;
    --user)   DEPLOY_USER="$2";  shift 2 ;;
    --help|-h)
      sed -n '/^# 用法/,/^[^#]/p' "$0" | head -n -1 | sed 's/^# \?//'
      exit 0 ;;
    *) die "未知参数: $1  (使用 --help 查看用法)" ;;
  esac
done

# ─── 权限检查 ─────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}Cherry Studio 网站部署${RESET}\n"
[[ "$EUID" -eq 0 ]] || die "请用 root 运行：sudo $0 $*"

log "配置信息："
log "  域名/IP     : ${DOMAIN}"
log "  网站目录    : ${WEB_ROOT}"
log "  源码仓库    : ${REPO_URL}"

# ─── 1. 系统依赖 ──────────────────────────────────────────────────────────────
log "安装系统依赖..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git nginx rsync

# 安装 Node.js 20（官方 NodeSource 源）
if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1 | tr -d v)" -lt "$NODE_VERSION" ]]; then
  log "安装 Node.js ${NODE_VERSION}..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y -qq nodejs
fi
log "  Node.js $(node --version) ✓"

# 安装 yarn（通过 Corepack）
if ! command -v yarn &>/dev/null; then
  log "安装 yarn..."
  corepack enable
  corepack prepare yarn@stable --activate
fi
log "  yarn $(yarn --version) ✓"

success "系统依赖安装完成 ✓"

# ─── 2. 克隆并构建 ────────────────────────────────────────────────────────────
log "克隆 Docusaurus 仓库..."
rm -rf "$BUILD_DIR"
git clone --depth=1 "$REPO_URL" "$BUILD_DIR"

log "安装 npm 依赖..."
cd "$BUILD_DIR"
yarn install --immutable

log "构建静态文件..."
yarn build

success "构建完成 ✓  (输出目录: ${BUILD_DIR}/build)"

# ─── 3. 部署到网站目录 ────────────────────────────────────────────────────────
log "部署到 ${WEB_ROOT}..."
mkdir -p "$WEB_ROOT"
rsync -a --delete "${BUILD_DIR}/build/" "${WEB_ROOT}/"
chown -R www-data:www-data "$WEB_ROOT"
chmod -R 755 "$WEB_ROOT"

success "文件部署完成 ✓"

# ─── 4. Nginx 配置 ────────────────────────────────────────────────────────────
log "配置 Nginx..."

cat > /etc/nginx/sites-available/cherry-studio <<NGINX
# Cherry Studio 文档网站
# 由 scripts/website-install.sh 自动生成
# CI/CD 更新由 deploy-website.yml 处理

server {
    listen 80;
    server_name ${DOMAIN};

    root ${WEB_ROOT};
    index index.html;

    # Docusaurus 单页应用路由支持
    location / {
        try_files \$uri \$uri/ \$uri.html /index.html;
    }

    # 静态资源长缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";

    access_log /var/log/nginx/cherry-studio.access.log;
    error_log  /var/log/nginx/cherry-studio.error.log;
}
NGINX

# 启用站点，禁用默认站点
ln -sf /etc/nginx/sites-available/cherry-studio /etc/nginx/sites-enabled/cherry-studio
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

nginx -t || die "Nginx 配置检查失败，请查看错误信息"
success "Nginx 配置完成 ✓"

# ─── 5. 启动 / 重载 Nginx ─────────────────────────────────────────────────────
log "启动/重载 Nginx..."
systemctl enable nginx
systemctl reload-or-restart nginx

# ─── 6. 验证 ─────────────────────────────────────────────────────────────────
log "验证网站可访问性..."
WAIT=0
until curl -fsS --max-time 5 "http://${DOMAIN}/" -o /dev/null || (( WAIT >= 15 )); do
  sleep 1; (( WAIT++ ))
done

if curl -fsS --max-time 5 "http://${DOMAIN}/" -o /dev/null; then
  STATUS_CODE=$(curl -o /dev/null -s -w "%{http_code}" "http://${DOMAIN}/")
  success "网站验证通过 ✓  HTTP ${STATUS_CODE}"
else
  warn "网站暂时未响应，请稍等几秒后手动访问"
fi

# ─── 完成 ─────────────────────────────────────────────────────────────────────
echo ""
success "部署完成！🍒"
echo ""
echo -e "  ${BOLD}网站地址${RESET}  :  http://${DOMAIN}/"
echo ""
echo -e "  ${BLUE}后续 CI/CD 自动更新${RESET}（配置 GitHub Secrets）:"
echo -e "    WEBSITE_HOST    = ${DOMAIN}"
echo -e "    WEBSITE_USER    = \$(whoami)  # 有 sudo 权限的 SSH 用户"
echo -e "    WEBSITE_SSH_KEY = <SSH 私钥内容>"
echo ""
echo -e "  ${BLUE}日志查看${RESET}:"
echo -e "    tail -f /var/log/nginx/cherry-studio.access.log"
echo -e "    tail -f /var/log/nginx/cherry-studio.error.log"
echo ""
