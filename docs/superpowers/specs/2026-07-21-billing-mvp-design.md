# 收费 MVP 设计

## 目标与边界

在不改变线上备案展示、不开放真实收费、不触发生产部署的前提下，为科研网站建立可扩展的套餐、商品、订单、支付、订阅、权益、额度、退款、发票和管理审计能力。

首期支付固定以 `PAYMENT_MODE=mock` 开发和测试。微信、支付宝只提供接口骨架；缺少正式配置时必须明确返回“未配置”，不能伪造成功。生产普通用户不得通过 Mock 支付获得正式权益。

以下文件及其展示内容不在本项目修改范围内：

- `components/SiteFilingFooter.tsx`
- `public/beian-police.png`
- `app/layout.tsx` 中的备案展示
- `.github/workflows/deploy.yml`
- `deploy.sh`
- 域名、Nginx、DNS、SSL 和线上数据库配置

## 技术方案

继续使用 Next.js 16 App Router、TypeScript、Supabase Auth 和 Supabase Postgres。数据访问保留 Supabase JS，不引入 Prisma 或 Drizzle。

新增版本化 SQL migrations、RLS 策略和 PostgreSQL 事务函数。订单结算、订阅开通、权益发放、额度增加及回调事件处理必须位于同一个数据库事务中；额度预占、确认和返还也通过数据库原子函数完成。

业务代码按领域组织在 `lib/billing/`，Route Handler 只负责解析请求、认证授权、限流、调用领域服务和映射响应。所有收费 API 独立执行服务端认证，因为现有 `middleware.ts` 不覆盖 `/api/*`。

## 数据模型

### 商品与套餐

- `billing_plans`：Free、Pro 等套餐，包含周期、启用状态和展示元数据。
- `billing_products`：可售 SKU，包括 Pro Monthly、Pro Yearly 和 Credit Pack。价格使用整数分 `price_minor BIGINT`，币种首期固定为 `CNY`。
- `billing_plan_entitlements`：套餐对应的功能权限、周期用量上限和额度赠送规则。

价格、额度和权益以数据库为唯一真源。前端创建订单只能提交 `product_id`，服务端从数据库读取当前商品并把名称、价格、币种和权益版本写入订单快照。

### 订单与支付

- `billing_orders`：订单号、用户、商品、快照金额、币种、支付渠道、状态、创建/过期/支付时间、退款状态和协议版本。
- `billing_payments`：Provider 交易号、支付状态、金额、币种、请求幂等键和非敏感响应摘要。
- `billing_webhook_events`：Provider 事件 ID、验签状态、处理状态和安全载荷摘要；Provider 与事件 ID 组合唯一。

订单状态至少包含 `PENDING`、`PAID`、`FAILED`、`CANCELLED`、`CLOSED`、`REFUNDING`、`REFUNDED`。订单必须有过期时间。已支付、已关闭或已退款订单不能重新支付。

### 会员、权益与额度

- `billing_subscriptions`：用户、套餐、起止时间、状态和来源订单；首期不支持自动续费。
- `billing_user_entitlements`：用户实际权益、来源、有效期和覆盖值。
- `billing_usage_quotas`：用户、功能、统计周期、上限、已预占和已使用。
- `billing_usage_records`：单次科研任务的预占、成功、失败和释放状态，带全局幂等键。
- `billing_credit_accounts`：可用余额、预占余额和乐观锁版本。
- `billing_credit_ledger`：不可变额度流水，记录购买、赠送、预占、扣减、返还和人工调整。

额度不能出现负数。所有余额变化必须同时写入流水，重复幂等键不能再次改变余额。

### 售后与审计

- `billing_refund_requests` 与 `billing_refunds`
- `billing_invoice_requests`
- `billing_admin_audit_logs`

管理员人工开会员、调整额度、审核退款等操作必须记录操作者、目标用户、原因、前后值和时间，不能记录密钥或完整支付敏感载荷。

## 支付 Provider

统一 `PaymentProvider` 接口提供：

- `createPayment`
- `queryPayment`
- `closePayment`
- `refundPayment`
- `verifyWebhook`
- `parseWebhook`

实现三个 Provider：

- `MockPaymentProvider`：仅限本地、测试环境以及生产管理员/测试白名单。
- `WechatPayProvider`：接口和配置校验骨架；未配置时返回 `PROVIDER_NOT_CONFIGURED`。
- `AlipayProvider`：接口和配置校验骨架；未配置时返回 `PROVIDER_NOT_CONFIGURED`。

前端不能确认支付成功。Mock 页面只触发服务端 Provider 流程，最终仍由服务端查询/回调和数据库事务确认订单。

回调处理顺序：读取原始请求、验签、解析 Provider 事件、持久化唯一事件、锁定订单、核对订单号/金额/币种/状态、执行结算事务、标记事件完成。任何核对失败都不得发放权益。

## 统一科研用量流程

新增 `SubscriptionService`、`EntitlementService`、`UsageQuotaService`、`CreditService` 和统一的 `ResearchUsageService`。

每个付费科研任务执行：

1. 服务端确认用户身份。
2. 验证功能权益。
3. 检查每日或月度限制。
4. 原子预占次数和额度。
5. 执行科研任务。
6. 成功时确认扣减并写使用记录。
7. 失败时按同一任务幂等键返还预占。

现有 `checkUsageLimit()` 的硬编码、非原子和异常 fail-open 行为不能用于收费扣减。迁移期间可保留兼容包装，但最终所有 AI API 必须调用统一服务，不能复制会员判断。

## 功能开关和生产安全

环境变量至少包括：

```text
BILLING_FEATURE_ENABLED=false
PAYMENT_MODE=mock
BILLING_TEST_USER_IDS=
LEGAL_OPERATOR_NAME=
LEGAL_OPERATOR_CREDIT_CODE=
LEGAL_CONTACT_EMAIL=
```

并预留微信和支付宝商户配置，但 `.env.example` 只包含空值或说明，不包含真实密钥。

规则如下：

- `BILLING_FEATURE_ENABLED=false` 时隐藏公开入口，并由服务端拒绝创建订单和支付。
- production + mock 只允许管理员或 `BILLING_TEST_USER_IDS`；普通用户始终拒绝。
- production 中若尝试公开启用 Mock 支付，支付子系统拒绝初始化。
- 正式 Provider 缺少任一必要配置时拒绝启用该 Provider，不能回退到 Mock。
- 配置错误只记录缺少的变量名，日志不得输出变量值。

## 页面与后台

用户页面包括定价、结算、支付结果、账单中心、订单列表/详情、当前套餐、剩余额度、使用记录、退款申请和发票申请。首期通过服务端功能开关、管理员权限、测试白名单和非生产环境限制访问。

管理后台包括套餐、商品、订单、支付记录、订阅、权益、额度、退款、发票、回调事件和审计日志。管理员权限使用统一 `requireAdmin()` 服务端守卫；隐藏按钮不构成授权。

法律页面包括用户协议、隐私政策、会员服务协议、退款政策、AI 使用声明、学术诚信政策、发票说明和客服投诉说明。运营主体信息只从环境变量/配置读取；未确认的新主体不得写入代码。所有页面标注正式上线前需专业律师审核，并明确禁止论文代写、伪造数据、考试作弊和其他学术不端。

## 测试与验收

测试覆盖：后端商品定价、订单过期、Mock 支付、回调幂等、金额/币种不一致、重复支付、订阅与额度发放、会员到期、额度原子扣减、并发不产生负余额、失败返还、管理员权限、协议勾选、功能开关和 production Mock 限制。

数据库迁移只在本地或独立测试数据库验证，不连接或修改线上数据库。最终执行自动化测试、TypeScript 类型检查、定向 ESLint、生产构建和 `git diff --check`。

## 交付与部署限制

开发只在 `codex/billing-mvp` 隔离分支进行。阶段性提交不包含用户主工作区的翻译修改，不 push `main`，不触发 GitHub Actions，不登录腾讯云，不部署，不执行不可逆生产迁移，也不提交真实支付密钥。
