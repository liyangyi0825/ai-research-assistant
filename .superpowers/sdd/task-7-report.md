# Task 7 Report

## 状态

`DONE_WITH_CONCERNS`

订阅、权益、周期用量、额度和统一科研任务服务已实现。变更严格限制在 Task 7 的五个服务文件、三个测试文件和本报告；未修改 AI routes、UI、admin、migration、备案、部署或线上数据库，也未复制支付结算逻辑。

## 实现

- `SubscriptionService` 通过可注入 repository 查询当前订阅；默认 Supabase 查询使用 Postgres 特殊时间值 `now` 过滤 `starts_at <= now` 与 `ends_at > now`，到期时刻不再授权。
- `EntitlementService` 通过可注入 repository 查询有效期内的 user entitlement；PLAN 来源必须关联来源订单并具有完整、匹配的订单权益快照，ADMIN 来源必须是无订单的对象型覆盖值；缺失拒绝，异常 fail-closed。
- `UsageQuotaService` 与 `CreditService` 共用可注入 RPC adapter；组合 quota/credit 只调用一次 `billing_reserve_usage`，确认和释放分别调用 `billing_finalize_usage` 与 `billing_release_usage`，没有在 TypeScript 中读取余额后写余额。
- RPC adapter 区分 `USAGE_QUOTA_EXCEEDED` 与 `INSUFFICIENT_CREDITS`，映射 taskKey payload/state 冲突，并把未知数据库错误收敛为安全的 `BILLING_STORAGE_UNAVAILABLE`。
- `ResearchUsageService.run(input, task)` 固定执行权益检查、原子预占、任务执行和确认；同步异常、异步 reject、显式失败、失败/取消的 `Response` 或 `ReadableStream` 会释放预占。流式成功仅在流结束后确认。
- 对幂等 reserve replay 不重复执行 task；finalize/release 重试接受 Task 2 RPC 的幂等结果。
- 支付开会员、发额度和重复回调不重复发放继续由 `billing_settle_paid_order` 保证；Task 7 仅增加静态合约覆盖，没有结算写路径。

## TDD

- RED：先创建三组测试；定向命令因 `credits`、`research-usage`、`entitlements` 目标模块不存在而 3 组按预期失败，原有 112 项通过。
- GREEN：完成最小实现后，Task 7 定向 Billing 命令 129/129 通过。
- 新增覆盖：数据库时间边界、PLAN 快照来源、缺失/畸形 entitlement、单次组合原子预占、明确额度/配额错误、数据库 fail-closed、finalize/release 幂等重试、执行顺序、同步/异步/显式/流式失败释放、流结束确认、reserve replay 不重复执行、Task 2 settlement 合约。

## 验证

- `npm.cmd run test:billing -- tests/billing/subscriptions.test.ts tests/billing/credits.test.ts tests/billing/research-usage.test.ts`：129 passed，0 failed。
- `npm.cmd test`：132 passed，0 failed。
- `npm.cmd run typecheck`：退出码 0。
- Task 7 定向 ESLint：退出码 0，0 warning/error。
- `git diff --cached --check`（八个实现/测试文件）：退出码 0。
- 全仓 `npm.cmd run lint`：失败；24 errors、1452 warnings 均位于本任务未修改的既有文件，包括 `app/**`、`components/**`、`proxy/server.js`、`public/pdf.worker.min.mjs` 和 `test_ppt/*.js`。本任务没有越界修改这些历史问题。

## Concerns

- Task 2 的 `billing_settle_paid_order` 会发放订阅、权益和额度，但不会创建 `billing_usage_quotas` 周期行。`billing_reserve_usage` 对 quota 用量要求活动 quota 已存在，因此接入 Task 8 前必须确认现有数据准备流程会预建活动 quota；按本任务边界未增加 migration 或结算逻辑。
- 本任务没有连接任何数据库，RPC 并发、PostgREST 对数据库时间过滤和事务行为仍需在本地或完全隔离的测试数据库补充真实集成验证；禁止使用线上数据库。
