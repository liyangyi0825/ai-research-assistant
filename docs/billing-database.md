# Billing 数据库迁移

本目录的迁移建立收费 MVP 的数据表、RLS 策略和原子事务函数。金额列统一使用 `BIGINT` 整数分；额度与用量也使用整数，并由 `CHECK` 约束和条件更新共同防止负数。

## 安全边界

禁止对线上数据库执行这些迁移或本文命令。迁移验证只允许使用开发者本机 Supabase，或与生产完全隔离、可随时销毁的独立测试数据库。不要把任何数据库口令、支付密钥或真实回调载荷写入仓库和测试日志。

客户端角色只获得启用商品和本人账务数据的读取权限。创建订单、支付结算、退款、发票、额度与管理写入均由服务端使用受控身份完成。事务 RPC（包括支付 intent 的 claim/complete/fail/Mock confirm、`billing_consume_order_rate_limit` 与售后申请）均为 `SECURITY DEFINER`、固定 `search_path`，并撤销 `PUBLIC`、`anon` 和 `authenticated` 的执行权限，仅授权 `service_role`。`billing_payment_intents` 不向客户端开放读取，避免其中的 Provider token 暴露。

## 迁移顺序

1. `202607210001_billing_schema.sql`：19 张表、索引、约束和订单快照保护。
2. `202607210002_billing_rls.sql`：逐表启用 RLS，默认拒绝写入，并开放受策略约束的只读访问。
3. `202607210003_billing_functions.sql`：支付创建 intent、支付结算、用量预占/确认/释放和人工额度调整。
4. `202607230004_billing_after_sales.sql`：以前向升级方式增加退款/发票申请的 `(user_id, order_id)` 唯一约束，以及两个原子售后申请 RPC。已应用的 `001` 不回写。

## 退款与发票申请

应用层不得先查询订单再插入申请。服务端仅调用 `billing_request_refund` 或 `billing_request_invoice`；RPC 在一个事务内锁定订单、核对 owner，并优先返回同一 `(user_id, order_id)` 的既有申请。只有没有既有申请时才校验订单当前状态，申请金额和币种始终从锁定的订单派生。这样并发重试会稳定返回首次申请，不会因订单随后进入退款中等状态破坏幂等，也不会接受客户端计价字段。

## 订单与回调调用契约

创建订单时必须显式写入 `snapshot_entitlements`，不能依赖空数组默认值。该字段是下单时权益数组的不可变快照；每项必须包含非空 `feature_key` 和 `periodic_limit`（无限额时显式为 `null`），并包含 `configuration` 和非负 `credit_grant`。结算只读取这份订单快照，不回查可被后续修改的套餐权益目录。

订阅订单结算会在同一事务中按快照里每个非空 `periodic_limit` 创建 `billing_usage_quotas`。quota 关联刚创建的 subscription，`period_start`/`period_end` 直接复用该 subscription 的起止时间，因此月度和年度商品都与各自订阅周期一致。重复事件在结算终态前返回，quota 的 `(subscription_id, feature_key)` 唯一约束与 `ON CONFLICT DO NOTHING` 作为第二道幂等保护，绝不重置已有 `reserved_units` 或 `used_units`。Credit Pack 不进入订阅分支，不创建 quota。

创建 Provider 支付前，服务端必须先调用 `billing_claim_payment_intent`。该 RPC 锁定订单，并以订单 ID 和请求幂等键原子创建或接管一段有期限的 `CREATING` 租约；租约判断和截止时间只使用数据库 `clock_timestamp()`，不接受应用实例时间。`CREATED` 直接复用已持久化结果，未过期的其他创建者返回 `IN_PROGRESS`，只有 `CLAIMED` 调用者可以请求 Provider。成功结果通过 `billing_complete_payment_intent` 持久化交易号、token 和状态；Provider 返回的过期时间必须与 intent 中的订单快照表示同一时刻，RPC 只比较、不覆盖快照。失败通过 `billing_fail_payment_intent` 只记录安全错误码。失败或租约过期后可重试。当前 30 秒租约不续租；若 Provider 调用超过租期，另一个实例可能接管，因此确定性的 Provider 请求幂等键是防止重复创建的第二道防线。Mock 确认也从该表读取持久化结果，不依赖单进程 Map。

支付回调必须按以下顺序处理：

1. 先核对 URL Provider 与服务端支付模式，再读取载荷。`Content-Length` 声明超过 64 KiB 时立即返回 413；无声明或伪小声明仍按流中实际字节计数，超过 64 KiB 立即取消读取并返回 413。保留限制内载荷的原始 UTF-8 文本并计算 SHA-256；验签前不得信任或记录其中的订单号、金额等业务字段。
2. 先对原始载荷验签。无效签名以 `rejected:<sha256(raw_body)>` 作为内部 Provider 事件 ID，写入 `FAILED` 审计；业务字段全部为 `NULL`，`payload_summary` 仅保存 `payload_hash`，不保存原文、签名或敏感请求头。
3. 验签成功后才解析非敏感业务字段。解析失败同样使用 `rejected:<sha256(raw_body)>` 记录 hash-only `FAILED` 审计，并标记签名结果。
4. 对完整且已验签事件，以 `RECEIVED` 状态先写入 `billing_webhook_events`，同时保存 Provider、事件 ID、交易 ID、支付请求幂等键、金额、币种和支付时间。
5. 调用保持 9 参数签名的 `billing_settle_paid_order`；RPC 会锁定已持久化事件、订单和对应 payment intent，核对请求幂等键及 Provider 结果，并在同一事务内完成支付、权益/额度、订单、intent 与事件状态更新。
6. 若 RPC 抛错，在该失败事务之外用独立数据库语句把原事件标记为 `FAILED` 并写入安全的 `error_code`。该更新必须带 `WHERE status = 'RECEIVED'` 条件；若更新 0 行，必须重新读取事件并保留已提交的终态。数据库触发器同时禁止覆盖 `PROCESSED`/`FAILED` 终态或修改已接收载荷。不得把完整回调载荷或密钥写入错误字段。

同一 Provider 与事件 ID 的重放必须携带完全相同的交易 ID、支付请求幂等键、金额、币种和支付时间；任何差异都按载荷冲突拒绝。额度发放流水键包含 Provider 命名空间，避免不同 Provider 的相同事件 ID 冲突。

人工额度调整的每次调用（包括重放）都要求 active admin。重放必须使用相同目标用户、金额、币种、管理员和去空格后的原因，并返回首次操作的 `ledger_id` 与 `audit_id`。

## 仅限本地验证

先启动本地 Supabase，再在仓库根目录运行：

```powershell
supabase db reset
supabase migration up --local
```

`db reset` 会清除本地实例数据，只能对明确确认的本地环境使用。若使用独立测试数据库，应由测试环境负责人提供隔离实例并在运行前再次确认目标；本文不提供任何线上目标信息。

## 必须在隔离数据库补做的验证

静态测试只能核对 SQL 合约，不能证明 PostgreSQL 的实际事务语义。上线前必须在独立测试数据库验证：

- 全新数据库按顺序应用全部 migration；另从已应用 `001`–`003` 的本地或隔离测试数据库执行 `supabase migration up --local`，确认 `004` 以前向方式补齐约束与 RPC。
- `anon` 与 `authenticated` 不能写 Billing 表；认证用户只能读取本人账务数据，不能读取其他用户或管理/回调数据。
- 同一 Provider 事件并发结算只发放一次订阅、权益或额度；金额、币种、订单号、状态、渠道或过期时间不符时不发放。
- 同一订单跨数据库连接并发 claim 时只有一个调用者获得 `CLAIMED`；成功完成后其他连接复用完全相同的 `CREATED` 结果，失败或租约过期可安全接管。
- 同一任务键并发预占只生效一次；额度不足或周期限额不足时整笔事务回滚。
- 确认和释放只允许从 `RESERVED` 状态发生，重复调用保持幂等，且余额、预占和周期用量始终非负。
- 人工额度调整要求有效管理员、非空原因和唯一幂等键，并与审计记录在同一事务提交。
- 同一订单并发提交退款或发票申请只产生一行；重试返回相同申请 ID。跨用户订单 ID、不可申请状态及客户端伪造金额/币种均不能创建申请。

## 回滚原则

账务和审计记录不可作为普通发布回滚的一部分删除。首期 migration 采用向前修复：若隔离测试发现问题，新增后续修复 migration；应用侧先关闭 Billing 功能并停止新订单，再修复数据库代码。
## Finite AI continuations

Multi-stage AI work uses `billing_usage_continuations`, which is not readable or
writable by `anon` or `authenticated`. Server code provisions at most 32 explicit
stage rows through `billing_provision_usage_continuations`. For paid roots that RPC
calls `billing_finalize_usage` and inserts the stage rows in the same transaction;
legacy roots use the same finite rows with `p_finalize_usage = false`.

Each continuation is bound to the root user, task key, billing feature, operation
key, stage key, and a canonical SHA-256 request hash. The service-role-only
`billing_claim_usage_continuation`, `billing_complete_usage_continuation`, and
`billing_release_usage_continuation` RPCs lock the stage row before transitions.
`CLAIMED` leases prevent concurrent execution, `COMPLETED` is a terminal replay,
and release retains the request hash so only the identical failed request can retry.

The Concept Explorer provisions only `block:2`, `block:3`, and `block:4`. PPT
section generation derives four-slide batches from the submitted complete outline,
limits an operation to 20 batches, and prebinds `batch:1..N-1` hashes during batch
zero. PPT content generation and PPT section generation use different operation
keys.
