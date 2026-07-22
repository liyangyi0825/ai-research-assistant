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
