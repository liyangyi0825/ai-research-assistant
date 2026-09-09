#!/usr/bin/env bash
set -euo pipefail

STAGING_DIR="/var/www/ai-research-assistant-staging"
EXPECTED_BRANCH="codex/billing-mvp"
EXPECTED_PROCESS="ai-research-staging"

if [[ "$(pwd -P)" != "$STAGING_DIR" ]]; then
  echo "STAGE_F_DIRECTORY_MISMATCH" >&2
  exit 1
fi

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$EXPECTED_BRANCH" ]]; then
  echo "STAGE_F_BRANCH_MISMATCH" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "STAGE_F_TRACKED_WORKTREE_DIRTY" >&2
  exit 1
fi

if [[ ! -f ".env.local" ]]; then
  echo "STAGE_F_ENV_FILE_MISSING" >&2
  exit 1
fi

env_mode="$(stat -c '%a' .env.local)"
if [[ "$env_mode" != "600" && "$env_mode" != "400" ]]; then
  echo "STAGE_F_ENV_FILE_PERMISSIONS_UNSAFE" >&2
  exit 1
fi

npm ci
node --env-file=".env.local" --import tsx scripts/billing-stage-f-preflight.ts
npm run build
pm2 startOrReload deploy/staging/ecosystem.config.cjs --only "$EXPECTED_PROCESS" --update-env
pm2 describe "$EXPECTED_PROCESS"
