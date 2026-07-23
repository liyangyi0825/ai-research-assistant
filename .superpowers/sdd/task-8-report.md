# Task 8 Report: 接入现有 AI API

## 完成范围

- 新增 `lib/billing/ai-usage.ts`，集中处理：
  - `BILLING_FEATURE_ENABLED=false` 时复用现有免费限额与 usage 记录路径；
  - billing enabled 时从服务端会话取得 `userId`，并通过 `ResearchUsageService.run` 执行原子预占、确认和释放；
  - `featureKey`、`quotaUnits`、`creditAmount` 与 task key 生成；
  - `Idempotency-Key` 的 8-128 字符安全 ASCII 校验，以及缺失时的服务端 UUID；
  - 非流式响应在返回前确认；SSE 仅在正常结束后确认，error、显式序列化失败和 cancel 时释放；
  - 旧免费路径的 token usage 记录与多阶段任务兼容。
- 计划 Task 8 的 16 个 API 已改为最小 `withAiUsage` 包装，不再直接调用 `checkUsageLimit` / `insertUsageRecord`：
  - `chat`、`context-chat`、`cite`、`concept-explorer/ai`
  - `extract`、`generate-latex`、`keywords`、`literature-review`
  - `data-clean`、`papers/search`、`profile/summarize`、`summarize`
  - `polish`、`translate`、`ppt/generate-content`、`ppt/generate-section`
- 保留既有响应 JSON/SSE/ZIP 形状、状态码文案及科研任务主体逻辑。

## TDD 证据

- 初始 RED：`tests/billing/ai-route-integration.test.ts` 明确失败于 `app/api/chat/route.ts` 未导入集中 adapter。
- adapter 契约先 RED 于文件缺失，再以行为测试驱动开关兼容、服务端身份、幂等键、流完成/失败/cancel 与非流式确认。
- 最终定向测试和静态集成测试转绿。

## 验证

- `npm.cmd run test:billing`：150/150 通过。
- `npm.cmd test`：153/153 通过。
- `npm.cmd run typecheck`：通过。
- 目标 ESLint：通过。
- `git diff --check`：通过。

## 明确未完成 / 未触碰

- **`app/api/translate-page/route.ts` 未接入，也未修改。** 主工作区存在用户未提交修改，需在该修改提交/合并后单独协调接入。
- 未修改 UI、admin、legal、备案、部署、支付实现或线上数据库。
- 未连接线上数据库，未 push，未 deploy。

## Changes Required 修复（2026-07-23）

- task key 已加入服务端认证用户命名空间：
  - 格式为 `ai:<userId>:<feature>:<clientRootKey>`；
  - 同一客户端 key 在不同用户之间不再命中同一数据库唯一键；
  - 客户端 root key 仍执行 8–128 字符安全 ASCII 校验。
- 多阶段任务不再使用 `legacyUnmetered` 或 `skipLegacyUsage`：
  - 新增 service-role-only、`SECURITY DEFINER` 且固定 `search_path` 的
    `billing_assert_usage_continuation` RPC；
  - billing enabled 时，continuation 必须由 RPC 证明同一
    `userId + featureKey + taskKey` 的首阶段已经 `FINALIZED`，否则以 409
    拒绝并且不执行 AI 任务；
  - billing disabled 时，continuation 仍强制携带安全 root key，但保留旧路径
    仅首阶段检查并写入一次 usage 的兼容行为。
- `concept-explorer` 每次探索生成一个浏览器 UUID，block 1 正常结算后，
  blocks 2–4 才携带同一 `Idempotency-Key` 执行；block 2 空结果不再绕过 adapter。
- PPT 正文每次生成使用一个 root UUID，batch 0 正常结算，后续 batch 及重试
  只有在首批已确认后才能以同一 key 继续。
- SSE guard 现在增量解析 `text/event-stream` 的 `data:` JSON，支持 JSON 行跨
  chunk；发现 `type: "error"` 或 provider `error` 字段时仍原样转发事件，
  但最终让流失败，从而释放预占而不是确认。

## Changes Required TDD 证据

- task namespace RED：两个用户携带同一 client key 时测试观察到相同旧 task key；
  实现用户命名空间后 GREEN。
- SSE RED：跨 chunk 的真实 `data: {"type":"error"}` 正常关闭后错误地 finalize；
  加入增量 detector 后事件保持原样且 reservation release。
- continuation migration RED：RPC、权限和数据库类型均缺失；补齐
  service-role-only RPC 后 migration 测试 GREEN。
- continuation adapter RED：旧 `legacyUnmetered` 仍绕过检查、enabled continuation
  仍重复 reserve；改为服务端证明后 GREEN。
- route/UI RED：block 2 提前返回、路由仍含信任式旁路且页面未发送 root header；
  两条调用链共享 root key 后 GREEN。

## Changes Required 最终验证

- 定向 adapter / route / migration / RPC 测试：56/56 通过。
- `npm.cmd run test:billing`：156/156 通过。
- `npm.cmd test`：159/159 通过。
- `npm.cmd run typecheck`：通过。
- 目标 ESLint：通过。
- `git diff --check`：通过。
- **`app/api/translate-page/route.ts` 仍未修改。**
