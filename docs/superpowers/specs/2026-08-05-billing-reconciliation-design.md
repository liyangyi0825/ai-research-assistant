# Billing 内部只读对账与脱敏日志设计

## 目标

在不依赖真实微信或支付宝接口、不修改任何账务数据的前提下，为管理员提供收费系统内部一致性报告，并为支付关键失败建立默认脱敏结构化日志。

本阶段只用于开发和测试验收。收费功能继续保持关闭，正式 Provider 继续保持不可启用。

## 非目标

- 不查询微信或支付宝商户平台。
- 不创建生产定时任务，不修改 GitHub Actions、腾讯云或其他部署配置。
- 不自动关闭订单、补写支付、开通会员、发放额度、处理退款或修复回调状态。
- 不提供“修复”按钮。
- 不记录回调原文、签名、密钥、用户邮箱、税号或其他敏感业务字段。

## 方案概览

新增一个服务端只读对账服务。它通过 service role 对账务表执行有限查询，将异常归一化为不含敏感信息的报告项。管理员 API 和管理页面只能读取报告，所有入口继续执行现有服务端管理员权限验证。

Webhook 与支付创建路径增加默认安全日志器。日志器只接受固定事件代码和白名单上下文字段，不接受任意对象或原始异常，避免调用方误将密钥、回调载荷或个人信息写入日志。

## 内部一致性检查

第一版检查以下确定性规则：

1. `ORDER_EXPIRED_PENDING`
   - 订单状态为 `PENDING`，且 `expires_at <= 数据库当前时间`。
   - 仅报告；不自动改为 `CLOSED`。
2. `PAID_ORDER_PAYMENT_MISSING`
   - 订单状态为 `PAID`，但不存在匹配的 `PAID` 支付记录。
3. `PAYMENT_ORDER_MISMATCH`
   - 已支付记录与订单的用户、Provider、金额或币种不一致。
4. `WEBHOOK_STALLED`
   - 回调状态为 `RECEIVED` 或 `PROCESSING`，且创建/更新时间早于明确的滞留阈值。
   - 默认阈值为 15 分钟，由服务端常量定义；本阶段不增加生产环境变量。
5. `SUBSCRIPTION_GRANT_MISSING`
   - 已支付订阅商品订单不存在以该订单为来源的订阅记录。
6. `CREDIT_GRANT_MISSING`
   - 已支付且快照额度大于零的 Credit Pack 订单不存在对应 `PURCHASE` 流水。
7. `REFUND_STATE_MISMATCH`
   - 订单为 `REFUNDING`/`REFUNDED`，但退款状态、退款记录或审核状态不满足现有状态契约。

检查只依据数据库中已持久化的服务端快照与账务记录。由于真实 Provider 未实现，报告不得声称已完成外部支付对账。

## 报告数据结构

报告顶层包含：

- `generatedAt`：服务端生成时间。
- `scope`：固定为 `INTERNAL_DATABASE_ONLY`。
- `summary`：按严重级别和异常代码计数。
- `items`：异常项列表，按严重级别、时间和稳定标识排序。
- `truncated`：是否因安全上限截断。

每个异常项仅包含：

- 固定 `code`。
- `severity`：`CRITICAL`、`WARNING` 或 `INFO`。
- `entityType`。
- 内部记录 ID 或订单号等非密钥稳定标识。
- `detectedAt`。
- 固定、无敏感信息的说明文本。

不得包含回调原文、`payload_summary`、签名、Provider token、密钥、邮箱、税号、用户资料或完整异常堆栈。报告最多返回 200 项，超过时设置 `truncated=true`。

## 数据访问与权限

- 新增独立的 reconciliation repository，只实现读取方法。
- repository 接口不得暴露 `insert`、`update`、`delete` 或写 RPC。
- 管理 API 使用现有 `createAdminBillingHandler`/`requireBillingAdmin` 服务端边界。
- 普通用户、匿名用户和只读页面隐藏都不能替代服务端权限校验。
- 数据库查询失败时整体 fail closed，返回安全的 `BILLING_STORAGE_UNAVAILABLE`，不返回不完整的“全部正常”报告。
- 单项数据格式不符合契约时视为存储异常，不静默跳过。

## API 与页面

- 新增 `GET /api/admin/billing/reconciliation`。
- 新增 `/admin/billing/reconciliation` 管理页面。
- 页面展示生成时间、内部数据库范围声明、摘要计数和异常项。
- 页面明确注明“只读报告，不会自动修改账务；不代表已与支付平台对账”。
- 不新增触发修复、批量关闭或状态覆盖按钮。

## 脱敏结构化日志

新增 Billing 安全日志接口，只允许以下字段：

- `eventCode`
- `provider`
- `orderNumber`（仅在已经验签或服务端自身生成时）
- `providerEventId`（仅在已经验签或内部拒绝事件 ID 时）
- `errorCode`
- `status`

第一阶段记录：

- 回调验签失败。
- 回调解析失败。
- 回调结算失败。
- 支付创建失败。
- 支付 intent 完成持久化失败。

日志消息和字段使用固定白名单，禁止传入原始错误对象、请求头、回调体、签名、密钥或 Provider token。默认实现可写入服务器标准错误流，未来接入外部监控时复用同一接口。

## 错误与运行语义

- 对账报告查询失败返回 503，不输出部分报告。
- 报告发现异常仍返回 200；异常属于业务检查结果，不是 API 故障。
- `BILLING_FEATURE_ENABLED=false` 不阻止管理员读取内部报告。
- 功能开关关闭时停止新销售，但已付款且验签通过的回调仍继续结算。
- 正式 Provider 未实现时继续由启动校验返回 `PROVIDER_NOT_IMPLEMENTED`。

## 测试策略

1. Repository 合约测试确认只读取允许的表和字段，没有写操作。
2. 行为测试覆盖全部七类异常、无异常报告、200 项截断和稳定排序。
3. 数据库错误或畸形行必须 fail closed，不能返回“正常”。
4. API 测试确认普通用户在 repository 调用前被拒绝，管理员可以读取。
5. 页面测试确认范围声明、只读说明和无修复按钮。
6. 日志测试确认固定事件被记录，原始载荷、签名、密钥、邮箱、税号和异常堆栈不会出现。
7. 回归测试确认 Mock 流程、关闭态商品隐藏和已付款回调结算语义不变。
8. 完成后运行全量测试、类型检查、定向 ESLint、生产构建、`npm audit` 和 `git diff --check`。

## 上线门槛与后续阶段

本阶段完成后只能认定具备“内部数据库一致性检查”，不能认定具备外部支付对账或生产监控。

正式收费前仍必须：

- 实现并验收真实微信/支付宝 Provider。
- 接入实际告警平台并验证告警送达。
- 实现 Provider/商户账单只读对账。
- 填写运维负责人、阈值和处置时限。
- 完成备份恢复、回调积压和财务对账演练。
- 完成法律文本专业审核和运营主体信息确认。
