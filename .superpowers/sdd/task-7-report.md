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

- 原 quota 预建 concern 已由下方 Changes Required 修复关闭：订阅结算现在会原子创建对应活动 quota。
- 本任务没有连接任何数据库，RPC 并发、PostgREST 对数据库时间过滤和事务行为仍需在本地或完全隔离的测试数据库补充真实集成验证；禁止使用线上数据库。

---

## Changes Required：订阅 quota 原子建档

### 状态

`DONE_WITH_CONCERNS`

审查指出的运行时断点已修复：原 `billing_settle_paid_order` 创建 subscription 和 entitlement，却没有创建 `billing_usage_quotas`，因此所有需要 quota 的任务会在 `billing_reserve_usage` 收到 `active usage quota not found`。本轮定向扩展 Task 2 schema/settlement/types/tests/docs，并同步 Task 4 snapshot type 与 Task 7 错误和权益有效期规则。

### 实现

- `billing_usage_quotas` 新增 nullable `subscription_id` 外键与 `(subscription_id, feature_key)` 唯一约束，兼容非订阅来源 quota，同时为订阅 quota 提供明确幂等来源。
- SUBSCRIPTION 结算先验证 immutable `snapshot_entitlements`：每项必须是对象、具有非空 `feature_key`，并显式包含 `periodic_limit`；非 null limit 必须是非负整数。畸形快照整笔结算 fail-closed。
- 结算从刚插入的 subscription 行读取 `starts_at`/`ends_at`，按订单快照的非 null `periodic_limit` 原子创建 quota。月度和年度商品自然使用各自订阅周期；没有回读可变 `billing_plan_entitlements`。
- quota 插入使用 `ON CONFLICT (subscription_id, feature_key) DO NOTHING`；同事件终态重放在建档前返回，既不重复建档，也不更新或重置 `reserved_units`/`used_units`。
- CREDIT_PACK 不进入 subscription 分支，不创建 quota。
- `BillingOrderEntitlementSnapshot` 移至数据库类型并明确 `periodic_limit: number | null`；Task 4 repository 复用该类型。现有订单 mapper 已持久化所需 limit 与 duration，因此无需增加新的订单快照字段。
- `active usage quota not found` 现在返回 `USAGE_QUOTA_NOT_PROVISIONED`/503；只有真实 `usage quota exceeded` 返回 429。
- PLAN entitlement 强制 `validUntil` 非空且晚于当前时刻；ADMIN entitlement 才允许 `validUntil=null`，有限期 ADMIN grant 到期同样拒绝。

### TDD

- RED 1：新增 settlement→quota→reserve 合约与畸形快照测试；2 项分别因 quota 无 subscription lineage、settlement 无 quota provisioning/validation 失败。
- GREEN 1：schema、settlement、types 和 docs 最小修改后，migration/订单/Task 7 联合定向 131/131 通过。
- RED 2：新增缺失 active quota 的错误语义测试；实际仍返回 `USAGE_QUOTA_EXCEEDED`/429。
- GREEN 2：拆分 provisioning 与 exhausted 映射后，联合定向 132/132 通过。
- RED 3：新增 PLAN 无限期/到期与 ADMIN 有限期到期测试；2 项因服务信任 repository 结果而未拒绝。
- GREEN 3：加入来源有效期约束和可注入时钟后，联合定向 134/134 通过。

### 验证

- migration/Task 4/Task 7 定向 Billing 命令：134 passed，0 failed。
- `npm.cmd test`：137 passed，0 failed。
- `npm.cmd run typecheck`：退出码 0。
- 本轮修改文件定向 ESLint：退出码 0，0 warning/error。
- 全仓 `npm.cmd run lint`：仍为历史基线失败，24 errors、1452 warnings；本轮修改文件不在错误列表。
- `git diff --check`：退出码 0。

### Remaining concern

- 本机未运行 PostgreSQL/Supabase 集成测试；JSONB 快照校验、subscription/quota 同事务写入、重复事件并发和 reserve 消费仍须在本地或完全隔离的测试数据库验证。禁止使用线上数据库。
