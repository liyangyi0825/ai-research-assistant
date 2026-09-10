# 收费系统监控与处置手册（上线前草案）

> 本文定义上线前需要落实的监控与人工处置流程，不表示监控、告警、备份或自动修账已经接入。收费功能默认保持关闭，直到获得单独的上线授权。

## 目录、订阅与退款操作契约

- 迁移 `202609100019_monthly_semester_catalog.sql` 的目标活跃目录是：`PRO_MONTHLY`（1990 个 CNY 最小货币单位、30 天、`pro-v1`）、`PRO_SEMESTER`（7900 个 CNY 最小货币单位、150 天、`pro-semester-v1`）和 `CREDIT_PACK_100`（990 个 CNY 最小货币单位、100 credits、`credit-v1`）。文档与迁移存在不代表生产已经迁移或部署。
- 学期套餐与月套餐使用相同的 13 个功能键，各项额度严格为月套餐的 5 倍；学期额度覆盖一个完整 150 天周期，不按月重置。
- 两种订阅均为微信 Native 一次性支付，`auto_renew=false`。用户已有尚未到期的 `ACTIVE` 订阅或另一笔尚未过期的 `PENDING` 订阅订单时，新订阅订单必须稳定返回 `409 ACTIVE_SUBSCRIPTION_EXISTS`；credits 包仍可购买。
- 完全未使用的月套餐或学期套餐只允许全额原路退款。任一相关额度已经使用时必须转人工审核，不得自动退款、按比例退款或折算剩余天数。
- `PRO_YEARLY`、`FREE` 商品及其他未批准 SKU 仍禁止激活。迁移 `019`、应用部署、真实凭据注入、微信真实金额验证、公开购买和最终保持商品活跃都必须分别审批。

## 值守信息（上线前填写）

| 项目 | 待填写值 |
| --- | --- |
| 当班负责人 | `待填写：姓名/角色/联系方式` |
| 升级负责人 | `待填写：姓名/角色/联系方式` |
| 财务对账负责人 | `待填写：姓名/角色/联系方式` |
| 安全事件负责人 | `待填写：姓名/角色/联系方式` |
| 告警接收渠道 | `待填写：工单/值班电话/受控群组` |
| 首次响应时限 | `待填写：例如 15 分钟` |
| 升级时限 | `待填写：例如 60 分钟` |
| 事件保留与复盘时限 | `待填写：由法务、安全和财务确认` |

未经填写并批准上述值，不得将本手册视作正式值守承诺。

## 上线前监控配置清单

以下每一项都需要在实际监控平台配置查询、阈值、接收人和升级规则；阈值与时限不得由开发人员自行猜测。

| 信号 | 建议检测范围 | 阈值与时限 | 首次处置 |
| --- | --- | --- | --- |
| 无效签名 | webhook 事件 `status=FAILED` 且 `error_code=INVALID_SIGNATURE` | `待填写` | 保留事件 ID、Provider、时间和 payload hash；不记录原始载荷或签名。 |
| 失败支付 | 订单、支付或 webhook 的 `FAILED` | `待填写` | 核对 Provider 侧状态与本地订单，不向用户伪造成功。 |
| 回调滞留 | webhook `RECEIVED` 或 `PROCESSING` 超过批准的窗口 | `待填写` | 查询事件 ID、锁定状态与错误码；必要时走经审批的人工重试流程。 |
| 金额/币种冲突 | 结算拒绝，且错误码为金额或币种不一致 | `待填写` | 立即保留订单号、Provider 交易号和事件 ID，发起人工对账。 |
| 存储或创建支付失败 | `BILLING_ADMIN_STORAGE_UNAVAILABLE`、创建支付失败或 Provider 创建失败 | `待填写` | 关闭新建支付入口，保留已验签的已付款回调结算。 |
| 账务对账 | `PENDING`、`PAID`、`REFUNDING` 订单与 Provider 对账单差异 | `待填写` | 记录差异并告警；禁止自动改订单、支付、退款、订阅、额度或流水。 |

## 日常对账步骤

1. 在批准的只读工具中按 Provider、日期和订单状态导出 `PENDING`、`PAID`、`REFUNDING` 的最小必要字段：订单号、金额、币种、状态、Provider 交易号与时间。
2. 使用经授权的商户后台或 Provider 对账单核对金额、币种、交易状态和退款状态。
3. 将差异记录到受控工单，包含证据位置、影响范围和下一次复核时间；不要把密钥、完整支付凭据或原始 webhook 写入工单。
4. 差异只能触发告警和人工复核，**不得**自动修改任何账务状态或发放/回收权益、额度。
5. 由待填写的财务与技术负责人完成双人复核后，才可通过受审计的管理流程进行单笔处置。

## 紧急停售与回调连续性

1. 将 `BILLING_FEATURE_ENABLED=false` 作为停售开关：隐藏公开购买入口，并拒绝新订单、创建支付、Mock 确认和售后写入。
2. 不要把该开关当作支付回调硬停开关。对于已付款订单，已验签的 Provider 回调必须继续进入结算链路，以避免已扣款但未发放权益。
3. 若必须硬停真实 Provider，需由待填写的负责人在商户侧暂停产品或支付能力，并保留只读查询、对账和人工处置渠道；记录批准人、时间和影响范围。
4. 恢复销售前，完成回调积压、订单、支付、退款、订阅与额度的人工对账，并获得明确恢复授权。

已有订阅或待支付订阅订单触发 `409 ACTIVE_SUBSCRIPTION_EXISTS` 是预期业务门禁，不应作为存储故障重试，也不得通过手工插入订单绕过。处置时只核对该用户的未到期 `ACTIVE` 订阅和未过期 `PENDING` 订阅订单；待它们到期或通过批准流程进入合法终态后，才允许再次创建订阅订单。credits 包入口保持可用。

## 备份与恢复边界

- 备份、恢复和点时间恢复只能在 Supabase 控制台或已审批的环境专用工具中执行，由环境负责人填写目标环境、变更单号、备份标识和审批记录。
- 本手册不提供可泛化的删除、重置、恢复或覆盖数据库命令；不得将测试库命令复制到生产环境。
- 在任何恢复演练前，确认目标是独立测试环境；在生产恢复前，必须获得变更审批、备份可用性证明、回滚方案和财务对账负责人确认。

## 事件记录最小字段

记录事件 ID、订单号、Provider、Provider 交易号、状态、错误码、时间、受理人和处置结论即可。不得记录商户密钥、Service Role Key、完整签名、原始 webhook 载荷、完整税号或完整投递邮箱。

## Internal database reconciliation report

- Administrators can view the read-only report at `/admin/billing/reconciliation`, or retrieve the same safe DTO from `GET /api/admin/billing/reconciliation`. Both require server-side administrator authorization.
- The scope is always `INTERNAL_DATABASE_ONLY`: it reads no WeChat, Alipay, Provider, or merchant-side data and does not establish completion of external payment reconciliation.
- The report renders no more than 200 findings; if the total exceeds that limit, `truncated=true` while the summary retains the complete count.
- Each of the seven internal sources has a 1000-row safety cap. If any source returns exactly 1000 rows, snapshot completeness is unknown and generation fails closed with `BILLING_STORAGE_UNAVAILABLE`; it must not be interpreted as a healthy or partial report. Report summary counts are complete only when generation succeeds.
- The seven finding codes are `ORDER_EXPIRED_PENDING`, `PAID_ORDER_PAYMENT_MISSING`, `PAYMENT_ORDER_MISMATCH`, `WEBHOOK_STALLED`, `SUBSCRIPTION_GRANT_MISSING`, `CREDIT_GRANT_MISSING`, and `REFUND_STATE_MISMATCH`.
- Findings are for manual investigation, recording, and review only. This page and API never automatically change orders, payments, refunds, subscriptions, credits, ledgers, or webhook states; any follow-up must use an approved, auditable manual process.

## Billing security event logger

- The server writes each allowlisted billing security event as one `billing_security_event` JSON record to server stderr. The event codes are `WEBHOOK_SIGNATURE_REJECTED`, `WEBHOOK_PARSE_REJECTED`, `WEBHOOK_SETTLEMENT_FAILED`, `PAYMENT_CREATE_FAILED`, and `PAYMENT_INTENT_PERSIST_FAILED`.
- Treat these records as a local diagnostic signal only. External alert delivery is not configured, and production monitoring is incomplete until the approved monitoring platform, alert recipients, escalation procedure, retention policy, and response tests are in place.
- Do not copy raw webhook bodies, signatures, headers, private keys, tokens, email addresses, tax identifiers, raw errors, or stacks into incident records. Use only the allowlisted provider, verified/server-owned order number or provider event ID, fixed error code, and fixed status.
