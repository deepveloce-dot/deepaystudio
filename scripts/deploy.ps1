<#
.SYNOPSIS
    Modaui Studio - Windows 自动全栈部署脚本

.DESCRIPTION
    一键完成 Modaui Studio 的 Windows 版本构建与发布流程：
      1. 环境检查  (Node.js, pnpm, Git)
      2. 安装/更新依赖
      3. 质量检查  (lint + format + typecheck + test)
      4. 版本号升级
      5. 提交版本变更 + 打 Git Tag
      6. 推送到远端  →  触发 GitHub Actions 自动构建并发布 Release
         (--Local 参数：跳过推送，直接在本机打包 .exe/.portable)

.PARAMETER VersionArg
    版本类型: patch | minor | major, 或明确版本号如 2.5.0
    留空则交互式提示选择。

.PARAMETER DryRun
    仅执行验证 (lint + test)，不修改版本，不推送。

.PARAMETER Local
    在本机直接打包 Windows 安装包，不提交不推送。
    输出目录: dist\

.EXAMPLE
    .\scripts\deploy.ps1
    .\scripts\deploy.ps1 patch
    .\scripts\deploy.ps1 2.5.0
    .\scripts\deploy.ps1 minor -DryRun
    .\scripts\deploy.ps1 patch -Local
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$VersionArg = "",

    [switch]$DryRun,
    [switch]$Local
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ─── 颜色辅助 ────────────────────────────────────────────────────────────────
function Write-Log    { Write-Host "[deploy] $args" -ForegroundColor Cyan }
function Write-Ok     { Write-Host "[deploy] $args" -ForegroundColor Green }
function Write-Warn   { Write-Host "[deploy] $args" -ForegroundColor Yellow }
function Write-Err    { Write-Host "[deploy] $args" -ForegroundColor Red; exit 1 }

# ─── 1. 环境预检 ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Modaui Studio — Windows 自动全栈部署" -ForegroundColor White -BackgroundColor DarkBlue
Write-Host ""

Write-Log "检查运行环境..."

# Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Err "未安装 Node.js。请从 https://nodejs.org 下载安装 v24.x LTS。"
}
$nodeVer = node --version
$nodeMajor = [int]($nodeVer -replace 'v(\d+).*', '$1')
if ($nodeMajor -lt 24) {
    Write-Err "需要 Node.js v24 以上（当前: $nodeVer）。请使用 fnm/nvm-windows 切换版本。"
}
Write-Log "  Node.js  $nodeVer ✓"

# pnpm
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Err "未安装 pnpm。请运行: npm install -g pnpm"
}
Write-Log "  pnpm     $(pnpm --version) ✓"

# Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err "未安装 Git。请从 https://git-scm.com 下载安装。"
}
Write-Log "  git      $(git --version) ✓"

# 必须在项目根目录执行
if (-not (Test-Path "package.json")) {
    Write-Err "请在项目根目录执行此脚本。"
}

# 工作区必须干净（非 DryRun/Local 模式）
if (-not $DryRun -and -not $Local) {
    $gitStatus = git status --porcelain
    if ($gitStatus) {
        Write-Err "工作区有未提交的变更，请先 commit 或 stash 后再运行。"
    }
}

# ─── 2. 安装依赖 ──────────────────────────────────────────────────────────────
Write-Log "安装/更新依赖..."
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Write-Err "pnpm install 失败。" }

# ─── 3. 质量检查 ──────────────────────────────────────────────────────────────
Write-Log "代码检查 (lint)..."
pnpm test:lint
if ($LASTEXITCODE -ne 0) { Write-Err "Lint 检查失败，请修复后重试。" }

Write-Log "格式检查..."
pnpm format:check
if ($LASTEXITCODE -ne 0) { Write-Err "格式检查失败，请运行 pnpm format 后重试。" }

Write-Log "类型检查..."
pnpm typecheck
if ($LASTEXITCODE -ne 0) { Write-Err "类型检查失败。" }

Write-Log "运行单元测试..."
pnpm test
if ($LASTEXITCODE -ne 0) { Write-Err "测试失败，请修复后重试。" }

Write-Ok "所有检查通过 ✓"

# ─── DryRun 提前退出 ──────────────────────────────────────────────────────────
if ($DryRun) {
    Write-Ok "--DryRun: 验证完成，未修改版本，未推送。"
    exit 0
}

# ─── 4. 确定版本号 ────────────────────────────────────────────────────────────
$currentVersion = node -p "require('./package.json').version"

function Resolve-VersionType([string]$arg) {
    if ($arg -match '^\d+\.\d+\.\d+') { return "explicit:$arg" }
    switch ($arg) {
        "patch" { return "patch" }
        "minor" { return "minor" }
        "major" { return "major" }
        ""      { return "" }
        default { Write-Err "无效的版本参数: '$arg'。请使用 patch|minor|major 或明确版本号如 2.5.0。" }
    }
}

$versionType = Resolve-VersionType $VersionArg

if ($versionType -eq "") {
    Write-Host ""
    Write-Host "  当前版本: $currentVersion" -ForegroundColor Yellow
    Write-Host "  请选择升级类型:"
    Write-Host "    1) patch  (bug 修复,  如 2.0.0 → 2.0.1)"
    Write-Host "    2) minor  (新功能,    如 2.0.0 → 2.1.0)"
    Write-Host "    3) major  (重大变更,  如 2.0.0 → 3.0.0)"
    Write-Host "    4) 手动输入版本号"
    $choice = Read-Host "请输入选项 [1]"
    switch ($choice) {
        "2"     { $versionType = "minor" }
        "3"     { $versionType = "major" }
        "4"     {
                    $customVer = Read-Host "请输入版本号 (如 2.5.0)"
                    $versionType = "explicit:$customVer"
                }
        default { $versionType = "patch" }
    }
}

# 应用版本号
if ($versionType -match '^explicit:(.+)') {
    $newVersionNum = $Matches[1]
    npm version $newVersionNum --no-git-tag-version --allow-same-version | Out-Null
} else {
    pnpm version $versionType --no-git-tag-version | Out-Null
}

$newVersion = node -p "require('./package.json').version"
$tag = "v$newVersion"

Write-Log "版本: $currentVersion → $newVersion"

# ─── 5. 提交 + 打 Tag ────────────────────────────────────────────────────────
Write-Log "提交版本变更..."
git add package.json
git commit --signoff -m "chore(version): bump to $newVersion"
git tag -a $tag -m "Release $newVersion"
Write-Ok "已打标签 $tag"

# ─── 6. 推送 或 本地打包 ──────────────────────────────────────────────────────
if ($Local) {
    Write-Warn "--Local: 跳过推送，开始本机打包 Windows 安装包..."
    Write-Log "执行 pnpm build:win ..."
    $env:NODE_OPTIONS = "--max-old-space-size=8192"
    pnpm build:win
    if ($LASTEXITCODE -ne 0) { Write-Err "Windows 构建失败。" }
    Write-Host ""
    Write-Ok "✅ 本地构建完成！安装包输出在 dist\ 目录："
    Get-ChildItem -Path "dist" -Include "*.exe","*.blockmap" -Recurse |
        Select-Object Name, @{N='大小(MB)';E={[math]::Round($_.Length/1MB,1)}} |
        Format-Table -AutoSize
} else {
    $currentBranch = git rev-parse --abbrev-ref HEAD
    Write-Log "推送分支 '$currentBranch' 和标签 '$tag' 到 origin..."
    git push origin $currentBranch
    git push origin $tag
    Write-Host ""
    Write-Ok "✅ 推送完成！GitHub Actions 自动部署已触发。"

    $remoteUrl = git remote get-url origin 2>$null
    $repoWeb   = $remoteUrl -replace '\.git$', '' -replace 'git@github\.com:', 'https://github.com/'
    Write-Host ""
    Write-Host "  监控构建进度: $repoWeb/actions" -ForegroundColor Cyan
    Write-Host "  构建完成后 Release 将自动发布到:" -ForegroundColor Cyan
    Write-Host "  $repoWeb/releases" -ForegroundColor Cyan
    Write-Host ""
}
