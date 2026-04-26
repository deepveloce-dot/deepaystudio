#!/usr/bin/env bash
# scripts/deploy.sh
#
# One-command full-stack deploy helper.
#
# Usage:
#   ./scripts/deploy.sh                     # interactive: prompts for version type
#   ./scripts/deploy.sh patch               # bump patch version and deploy
#   ./scripts/deploy.sh minor               # bump minor version and deploy
#   ./scripts/deploy.sh major               # bump major version and deploy
#   ./scripts/deploy.sh 2.5.0               # set an explicit version and deploy
#   ./scripts/deploy.sh patch --dry-run     # validate only, no tag/push
#   ./scripts/deploy.sh patch --local       # build locally (no git push)
#
# What this script does
# ─────────────────────
#   1. Pre-flight checks  (git clean tree, Node, pnpm)
#   2. Install / update dependencies
#   3. Lint + format + type-check + tests
#   4. Bump version  (patch | minor | major | <explicit>)
#   5. Commit the version bump, create an annotated git tag
#   6. Push branch + tag  →  triggers the auto-deploy.yml workflow in GitHub CI
#      (skip with --local flag for a local-only build)
#
# The GitHub Actions workflow then builds installers for Windows, macOS and
# Linux in parallel and publishes a GitHub Release automatically.

set -euo pipefail

# ─── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

log()    { echo -e "${BLUE}[deploy]${RESET} $*"; }
success(){ echo -e "${GREEN}[deploy]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[deploy]${RESET} $*"; }
error()  { echo -e "${RED}[deploy]${RESET} $*" >&2; }
die()    { error "$*"; exit 1; }

# ─── argument parsing ─────────────────────────────────────────────────────────
VERSION_ARG=""
DRY_RUN=false
LOCAL_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=true ;;
    --local)      LOCAL_BUILD=true ;;
    --help|-h)
      sed -n '/^# Usage/,/^[^#]/p' "$0" | head -n -1 | sed 's/^# \?//'
      exit 0 ;;
    -*)           die "Unknown flag: $arg  (use --help for usage)" ;;
    *)            VERSION_ARG="$arg" ;;
  esac
done

# ─── 1. pre-flight checks ─────────────────────────────────────────────────────
echo -e "\n${BOLD}Modaui Studio – Auto Full-Stack Deploy${RESET}\n"

log "Checking prerequisites…"

# Node
command -v node >/dev/null 2>&1 || die "Node.js is not installed."
NODE_VER=$(node --version)
REQUIRED_MAJOR=24
ACTUAL_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
if [ "$ACTUAL_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
  die "Node.js ${REQUIRED_MAJOR}+ required (found ${NODE_VER}). Use nvm/fnm to switch versions."
fi
log "  Node.js  ${NODE_VER} ✓"

# pnpm
command -v pnpm >/dev/null 2>&1 || die "pnpm is not installed. Run: npm install -g pnpm"
log "  pnpm     $(pnpm --version) ✓"

# git
command -v git >/dev/null 2>&1 || die "git is not installed."
log "  git      $(git --version | awk '{print $3}') ✓"

# Must run from the repo root
[ -f "package.json" ] || die "Run this script from the repository root."

# Clean working tree (unless dry-run)
if [ "$DRY_RUN" = false ] && [ "$LOCAL_BUILD" = false ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    die "Working tree has uncommitted changes. Commit or stash them first."
  fi
fi

# ─── 2. install / update dependencies ────────────────────────────────────────
log "Installing dependencies…"
pnpm install --frozen-lockfile

# ─── 3. quality checks ────────────────────────────────────────────────────────
log "Running lint…"
pnpm test:lint

log "Checking formatting…"
pnpm format:check

log "Type-checking…"
pnpm typecheck

log "Running tests…"
pnpm test

success "All checks passed ✓"

# ─── dry-run early exit ───────────────────────────────────────────────────────
if [ "$DRY_RUN" = true ]; then
  success "--dry-run: validation complete, no version bump or push performed."
  exit 0
fi

# ─── 4. resolve version bump ──────────────────────────────────────────────────
CURRENT_VERSION=$(node -p "require('./package.json').version")

resolve_version_type() {
  local arg="$1"
  # semver-like explicit version (e.g. 2.5.0)
  if echo "$arg" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
    echo "explicit:$arg"
    return
  fi
  case "$arg" in
    patch|minor|major) echo "$arg" ;;
    "") echo "" ;;
    *) die "Invalid version argument: '$arg'. Use patch|minor|major or an explicit version like 2.5.0." ;;
  esac
}

VERSION_TYPE=$(resolve_version_type "$VERSION_ARG")

if [ -z "$VERSION_TYPE" ]; then
  echo ""
  echo -e "Current version: ${BOLD}${CURRENT_VERSION}${RESET}"
  echo -e "Select bump type:\n  1) patch  (bug-fix)\n  2) minor  (new feature)\n  3) major  (breaking change)\n  4) custom version"
  read -rp "Choice [1]: " CHOICE
  case "${CHOICE:-1}" in
    1|patch) VERSION_TYPE="patch" ;;
    2|minor) VERSION_TYPE="minor" ;;
    3|major) VERSION_TYPE="major" ;;
    4|custom)
      read -rp "Enter version (e.g. 2.5.0): " CUSTOM_VER
      VERSION_TYPE="explicit:${CUSTOM_VER}"
      ;;
    *) die "Invalid choice." ;;
  esac
fi

# Apply version bump
if echo "$VERSION_TYPE" | grep -q '^explicit:'; then
  NEW_VERSION="${VERSION_TYPE#explicit:}"
  npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version
else
  pnpm version "$VERSION_TYPE" --no-git-tag-version
fi

NEW_VERSION=$(node -p "require('./package.json').version")
TAG="v${NEW_VERSION}"

log "Version: ${CURRENT_VERSION} → ${NEW_VERSION}"

# ─── 5. commit + tag ─────────────────────────────────────────────────────────
log "Committing version bump…"
git add package.json
git commit --signoff -m "chore(version): bump to ${NEW_VERSION}"
git tag -a "${TAG}" -m "Release ${NEW_VERSION}"

success "Tagged ${TAG}"

# ─── 6. push (or local build) ────────────────────────────────────────────────
if [ "$LOCAL_BUILD" = true ]; then
  warn "--local: skipping git push. Building locally instead…"
  log "Detecting platform…"
  case "$(uname -s)" in
    Darwin) pnpm build:mac  ;;
    Linux)  pnpm build:linux ;;
    MINGW*|CYGWIN*|MSYS*) pnpm build:win ;;
    *) die "Unsupported OS: $(uname -s)" ;;
  esac
  success "Local build complete. Artifacts are in the dist/ directory."
else
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  log "Pushing branch '${CURRENT_BRANCH}' and tag '${TAG}' to origin…"
  git push origin "${CURRENT_BRANCH}"
  git push origin "${TAG}"
  success "Push complete."
  echo ""
  echo -e "  ${GREEN}▶${RESET} The ${BOLD}auto-deploy.yml${RESET} GitHub Actions workflow has been triggered."
  echo -e "  ${GREEN}▶${RESET} Monitor progress at:"
  REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "<your-repo>")
  REPO_WEB="${REMOTE_URL%.git}"
  # Convert SSH URLs to HTTPS for display
  REPO_WEB=$(echo "$REPO_WEB" | sed 's|git@github.com:|https://github.com/|')
  echo -e "    ${BLUE}${REPO_WEB}/actions${RESET}"
  echo ""
fi
