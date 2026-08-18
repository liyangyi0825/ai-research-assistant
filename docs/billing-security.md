# 收费系统安全说明

## 当前开放边界

- 收费功能默认关闭；`BILLING_FEATURE_ENABLED=false` 时公开定价页没有购买动作，收费 API 在服务端拒绝写操作。
- Mock 支付不能为普通生产用户授予权益，只允许本地/测试环境，以及生产环境的管理员或 `BILLING_TEST_USER_IDS` 白名单账号。
- 微信和支付宝 Provider 未配置时明确失败，不伪造支付成功。
- 当前阶段不得生成真实收费二维码、开放生产支付回调、自动扣款或自动续费。

## 服务端信任边界

- 用户和管理员身份均从服务端认证会话解析；管理员接口执行数据库管理员状态与角色校验。
- 订单价格、币种、商品、套餐与权益快照来自后端数据库，拒绝客户端金额、币种和用户 ID。
- 金额以 `BIGINT` 整数最小货币单位保存，人民币使用“分”，不进行浮点运算。
- 创建订单有原子持久化限流，订单设置到期时间。
- 前端不能确认支付成功。支付完成只能通过验签后的服务端回调结算；Mock 确认同样生成签名事件并进入统一回调链路。

## 回调、事务与幂等

- Provider 暴露统一的签名校验和回调解析接口。
- 原始回调体有大小限制；无效签名只保留摘要，不信任或持久化业务字段。
- 结算核对 Provider、订单号、支付事务号、请求幂等键、金额、币种、支付时间、订单状态与到期时间。
- Webhook 事件、支付、订单、订阅、权益、额度和流水在数据库事务/RPC 中统一处理。
- 事件 ID、支付事务号、订单号、额度流水及任务幂等键具有唯一约束；重复事件不会重复开通会员或增加额度。
- 使用额度通过数据库锁和原子 RPC 预占、确认或释放；失败任务返还预占额度，余额和配额不能变成负数。

## 权限与账务完整性

- Billing 表启用 RLS；用户只读自己的账务数据，写入通过受控服务端仓库和仅授予 `service_role` 的 RPC。
- 已支付订单快照和额度流水不可修改，管理员调整也必须记录原因、幂等键和审计日志。
- 管理员查看与写入角色分离；普通用户及只读审核员不能执行额度调整、人工开通或退款审核。
- 退款和发票申请在数据库事务中锁定归属订单，金额与币种由订单快照派生。

## 密钥和日志脱敏

- 密钥只通过服务端环境变量或密钥管理服务注入，不写入数据库、代码、客户端 bundle 或版本库。
- 日志脱敏：不得记录 API v3 Key、商户/应用私钥、平台证书内容、Service Role Key、完整签名或原始敏感回调。
- 配置错误仅列出缺少的环境变量名；对用户返回稳定错误码，不透出数据库和 Provider 内部错误。
- 日志和审计记录只保留诊断所需的订单号、事件 ID、状态、哈希和非敏感元数据。

审计数据的保留期限、归档与合规删除规则必须在正式上线前由法务、安全和财务共同确定。上线前还必须建立管理员访问权限的定期复核、异常导出监控和审计数据导出审批。管理员操作的 `reason`、`before_value`、`after_value` 只记录证明操作所必需的最小字段；不得复制密钥、完整支付凭据、无关用户资料或大段原始请求。

## 备案与法律保护

收费开发不得修改 ICP 备案号、公安备案号、公安备案图标、备案主体、网站名称、域名、负责人、运营者、链接或展示位置，也不得修改生产部署、Nginx、DNS 和 SSL 配置。

法律页面是待律师审核的初稿。运营主体读取 `LEGAL_OPERATOR_NAME`、`LEGAL_OPERATOR_CREDIT_CODE` 和 `LEGAL_CONTACT_EMAIL`；备案变更完成前留空或继续使用已确认的合法内容，不切换到待审新主体。

平台仅用于科研辅助，禁止论文代写、伪造实验或研究数据、考试作弊及其他学术不端。AI 输出可能有误，用户必须自行核查引用、数据与结论。

## Billing security event logging

- The server emits only allowlisted security event codes. Refund execution adds `REFUND_PROVIDER_FAILED`, `REFUND_PERSIST_FAILED`, and `REFUND_EXECUTION_FAILED` to the existing webhook and payment codes; arbitrary event names are discarded.
- The default sink writes one `billing_security_event` JSON record per event to server stderr. Records are built only from the allowlisted event code, provider, verified or server-owned identifiers, fixed error code, and fixed status; raw webhook bodies, signatures, headers, keys, tokens, email addresses, tax identifiers, raw errors, and stacks are excluded.
- External alert delivery is not configured. Production monitoring remains incomplete until an approved monitoring, alert-routing, retention, and response process is configured and tested.

## Automatic refund boundary

- Automatic Provider refunds are limited to unused `SUBSCRIPTION` orders that contain no credit grant. The service derives the full refund amount and currency from the paid order and payment; administrators cannot supply either value.
- `CREDIT_PACK` requests return `REFUND_REQUIRES_MANUAL_REVIEW` before a claim lease is created or a Provider is called. The approved request remains available for an audited manual process.
- `RETRY_REQUIRED` means the approval was persisted but automatic execution did not finish. Operators must retry with the same review idempotency key so that the existing review and refund claim can be recovered safely.
- Once a Provider call may have occurred, the claim lease is retained and the same Provider refund idempotency key is reused. Deterministic configuration failures detected before the Provider call release the claim for a corrected retry.

## 上线前安全门

在正式收费前必须完成：

1. 备案和运营主体变更审核；
2. 专业律师审核协议与政策；
3. 独立 PostgreSQL 测试数据库中的迁移、RLS、锁、并发和回调重放验证；
4. Provider 官方沙箱联调、签名/验签、证书和密钥轮换演练；
5. HTTPS 回调域名、网络边界、告警和审计检查；
6. 数据备份、恢复和账务对账演练；
7. 明确授权后才更改功能开关，且不得把真实密钥提交到 Git。
