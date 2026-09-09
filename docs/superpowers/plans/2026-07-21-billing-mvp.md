# 收费 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在备案信息和生产部署配置保持不变的前提下，实现默认关闭、仅支持安全 Mock 测试的套餐、订单、支付、会员、权益、额度、账单和管理后台 MVP。

**Architecture:** 保留 Next.js 16、Supabase Auth 与 Supabase JS；新增版本化 PostgreSQL migrations、RLS 和原子 RPC。`lib/billing` 承载领域规则，Route Handler 只做认证、限流、输入解析和响应映射，用户及管理页面均由同一服务端功能开关控制。

**Tech Stack:** Next.js 16.2.6、React 19.2.4、TypeScript 5、Supabase/PostgreSQL、Node test runner + `tsx`、ESLint 9。

## Global Constraints

- 只在 `codex/billing-mvp` 隔离 worktree 工作；不得 push `main`、部署、连接或修改线上数据库。
- 不修改备案号、公安图标、主体、网站名称、域名、备案链接或展示位置。
- 不修改 `components/SiteFilingFooter.tsx`、`public/beian-police.png`、`app/layout.tsx` 的备案展示、`.github/workflows/deploy.yml` 或 `deploy.sh`。
- `PAYMENT_MODE=mock`；不接入真实商户密钥，不生成真实二维码，不开放自动续费。
- 金额使用整数分；前端金额永远不作为订单定价依据。
- 所有管理员 API 执行服务端权限验证；所有订单结算及额度变更必须幂等、原子。
- 每个任务采用 TDD：先写失败测试，确认失败，再实现最小代码并确认通过。

---

### Task 1: 测试基础设施与安全配置

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Create: `lib/billing/config.ts`
- Create: `lib/billing/errors.ts`
- Create: `tests/billing/config.test.ts`

**Interfaces:**
- Produces: `getBillingConfig(env?: NodeJS.ProcessEnv): BillingConfig`
- Produces: `assertPaymentRuntimeSafe(config, context): void`
- Produces: `BillingError(code, message, status)`

- [ ] **Step 1: 添加测试运行器**

运行 `npm.cmd install --save-dev tsx`，并将脚本设为：

```json
{
  "test": "tsx --test tests/**/*.test.{ts,mjs}",
  "test:billing": "tsx --test tests/billing/**/*.test.ts",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 2: 写配置失败测试**

覆盖：默认关闭、默认 Mock、生产关闭收费时允许启动、生产公开 Mock 拒绝、正式 Provider 缺变量拒绝、错误中只出现变量名而不出现值、测试用户 ID 去空格去重。

```ts
assert.throws(
  () => getBillingConfig({ NODE_ENV: "production", BILLING_FEATURE_ENABLED: "true", PAYMENT_MODE: "mock" }),
  (error: BillingError) => error.code === "UNSAFE_PAYMENT_CONFIGURATION",
);
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm.cmd run test:billing -- tests/billing/config.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现服务器端配置解析**

`BillingConfig` 必须包含 `featureEnabled`、`paymentMode`、`testUserIds`、`legal`、`wechatConfigured`、`alipayConfigured`。仅接受 `mock|wechat|alipay`，布尔值只接受显式 `true`。

- [ ] **Step 5: 更新 `.env.example`**

加入用户要求的全部 Billing、Legal、微信、支付宝变量；所有密钥保持空值，注释说明 Mock 仅限本地/测试/生产白名单。

- [ ] **Step 6: 运行测试与提交**

Run: `npm.cmd run test:billing -- tests/billing/config.test.ts`

Expected: PASS。

Commit: `feat: add billing safety configuration`

### Task 2: 收费数据库模型、RLS 与原子函数

**Files:**
- Create: `supabase/migrations/202607210001_billing_schema.sql`
- Create: `supabase/migrations/202607210002_billing_rls.sql`
- Create: `supabase/migrations/202607210003_billing_functions.sql`
- Create: `lib/billing/database.types.ts`
- Create: `tests/billing/migrations.test.ts`
- Create: `docs/billing-database.md`

**Interfaces:**
- Produces tables: `billing_plans`, `billing_products`, `billing_plan_entitlements`, `billing_orders`, `billing_payments`, `billing_subscriptions`, `billing_user_entitlements`, `billing_usage_quotas`, `billing_usage_records`, `billing_credit_accounts`, `billing_credit_ledger`, `billing_webhook_events`, `billing_refund_requests`, `billing_refunds`, `billing_invoice_requests`, `billing_admins`, `billing_admin_audit_logs`, `billing_rate_limits`
- Produces RPCs: `billing_settle_paid_order`, `billing_reserve_usage`, `billing_finalize_usage`, `billing_release_usage`, `billing_adjust_credit`

- [ ] **Step 1: 写 migration 结构测试**

测试读取 SQL 文件并断言：金额为 `BIGINT`、订单/退款枚举完整、唯一幂等约束存在、所有用户数据表启用 RLS、余额和预占非负 CHECK、事务函数为 `SECURITY DEFINER` 且固定 `search_path`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm.cmd run test:billing -- tests/billing/migrations.test.ts`

Expected: FAIL，migration 文件不存在。

- [ ] **Step 3: 创建 schema migration**

使用 UUID 主键、`auth.users(id)` 外键、`TIMESTAMPTZ`、整数分、不可变订单快照和 `created_at/updated_at`。订单号、支付 Provider 交易号、回调事件号、额度流水幂等键建立唯一索引。

- [ ] **Step 4: 创建 RLS migration**

普通认证用户只能读取自己的订单、支付、订阅、权益、额度、用量、退款及发票；商品只读取启用项；所有管理写入和结算 RPC 只允许 service role。

- [ ] **Step 5: 创建原子 RPC migration**

`billing_settle_paid_order` 锁定订单，依次核对订单号、金额、币种、状态和过期时间，插入支付记录，发放一次订阅/权益或额度，最后更新订单。重复同一事件返回已处理结果，不重复发放。

`billing_reserve_usage` 使用条件更新预占额度；`billing_finalize_usage` 将预占转为消耗；`billing_release_usage` 返还预占。所有函数以任务幂等键为唯一依据。

- [ ] **Step 6: 生成精确 TypeScript 类型和迁移文档**

文档明确只能对本地或独立测试 Supabase 执行：

```text
supabase db reset
supabase migration up --local
```

不得包含线上 project ref 或数据库口令。

- [ ] **Step 7: 运行测试与提交**

Run: `npm.cmd run test:billing -- tests/billing/migrations.test.ts`

Expected: PASS。

Commit: `feat: add billing data models`

### Task 3: 服务端认证、管理员授权与订单限流

**Files:**
- Create: `lib/billing/auth.ts`
- Create: `lib/billing/rate-limit.ts`
- Create: `tests/billing/auth.test.ts`
- Create: `tests/billing/rate-limit.test.ts`

**Interfaces:**
- Produces: `requireBillingUser(): Promise<BillingUser>`
- Produces: `requireBillingAdmin(): Promise<BillingAdmin>`
- Produces: `assertBillingAccess(user, config): void`
- Produces: `consumeOrderRateLimit(userId, now): Promise<void>`

- [ ] **Step 1: 写认证与权限失败测试**

覆盖无会话 401、普通用户访问管理员操作 403、停用管理员 403、功能关闭创建订单 404/403、production Mock 普通用户 403、白名单和管理员允许测试。

- [ ] **Step 2: 写限流失败测试**

同一用户在滑动窗口内超过阈值返回 429；窗口后恢复；数据库错误采用 fail-closed。

- [ ] **Step 3: 运行测试确认失败**

Run: `npm.cmd run test:billing -- tests/billing/auth.test.ts tests/billing/rate-limit.test.ts`

- [ ] **Step 4: 实现统一守卫和数据库限流**

管理员从 `billing_admins` 查询，不依赖前端或路由隐藏。兼容期可将 `ADMIN_EMAIL` 映射为 bootstrap 管理员，但每次管理 API 仍需服务端验证。

- [ ] **Step 5: 运行测试与提交**

Expected: PASS。

Commit: `feat: add billing authorization guards`

### Task 4: 商品和订单领域服务与 API

**Files:**
- Create: `lib/billing/products.ts`
- Create: `lib/billing/orders.ts`
- Create: `lib/billing/repositories.ts`
- Create: `app/api/billing/products/route.ts`
- Create: `app/api/billing/orders/route.ts`
- Create: `app/api/billing/orders/[id]/route.ts`
- Create: `tests/billing/orders.test.ts`
- Create: `tests/billing/order-routes.test.ts`

**Interfaces:**
- Produces: `listPublicProducts()`
- Produces: `createOrder({ userId, productId, provider, acceptedAgreementVersion })`
- Produces: `getUserOrder(userId, orderId)`

- [ ] **Step 1: 写订单领域失败测试**

覆盖创建订单、前端附带伪造金额无效、商品价格快照来自数据库、未勾选协议拒绝、停用商品拒绝、订单过期、订单号唯一、非本人不能读取。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm.cmd run test:billing -- tests/billing/orders.test.ts`

- [ ] **Step 3: 实现商品与订单服务**

Route body 只接受：

```ts
type CreateOrderBody = {
  productId: string;
  provider: "mock" | "wechat" | "alipay";
  acceptedAgreementVersion: string;
};
```

任何 `amount` 或 `currency` 字段均忽略或拒绝；服务端从商品表填充订单快照，默认 30 分钟过期。

- [ ] **Step 4: 实现 Route Handlers**

所有动态路由使用 Next.js 16 的异步 `ctx.params`；POST 依次执行认证、功能开关、限流、JSON 校验和领域服务。

- [ ] **Step 5: 运行测试与提交**

Run: `npm.cmd run test:billing -- tests/billing/orders.test.ts tests/billing/order-routes.test.ts`

Expected: PASS。

Commit: `feat: add secure billing orders`

### Task 5: PaymentProvider、Mock、微信和支付宝骨架

**Files:**
- Create: `lib/billing/payments/types.ts`
- Create: `lib/billing/payments/provider.ts`
- Create: `lib/billing/payments/mock.ts`
- Create: `lib/billing/payments/wechat.ts`
- Create: `lib/billing/payments/alipay.ts`
- Create: `lib/billing/payments/registry.ts`
- Create: `tests/billing/payment-providers.test.ts`

**Interfaces:**
- Produces `PaymentProvider` with exact methods `createPayment`, `queryPayment`, `closePayment`, `refundPayment`, `verifyWebhook`, `parseWebhook`
- Produces: `getPaymentProvider(mode, config)`

- [ ] **Step 1: 写 Provider 契约测试**

Mock 创建后为 PENDING，服务端测试确认后为 PAID，可查询、关闭和退款；签名使用仅测试环境生成的 HMAC secret。微信/支付宝缺配置时六个方法都返回 `PROVIDER_NOT_CONFIGURED`，绝不返回成功。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm.cmd run test:billing -- tests/billing/payment-providers.test.ts`

- [ ] **Step 3: 实现接口和 Mock Provider**

Provider 输入始终包含后端订单号、整数金额和币种。Mock 不生成真实二维码，只返回内部测试 token 和过期时间。

- [ ] **Step 4: 实现正式 Provider 骨架**

只校验配置和返回明确错误；不得写入任何真实 SDK 调用、商户示例密钥或假成功分支。

- [ ] **Step 5: 运行测试与提交**

Expected: PASS。

Commit: `feat: add mock payment provider`

### Task 6: 支付确认、回调验签和幂等结算

**Files:**
- Create: `lib/billing/payments/service.ts`
- Create: `lib/billing/payments/webhooks.ts`
- Create: `app/api/billing/payments/mock/confirm/route.ts`
- Create: `app/api/billing/webhooks/[provider]/route.ts`
- Create: `tests/billing/payment-service.test.ts`
- Create: `tests/billing/webhooks.test.ts`

**Interfaces:**
- Produces: `createOrderPayment(userId, orderId)`
- Produces: `processPaymentWebhook(provider, rawBody, headers)`
- Consumes: `billing_settle_paid_order`

- [ ] **Step 1: 写结算和回调失败测试**

覆盖 Mock 成功、前端不能直接设 PAID、重复回调幂等、金额/币种/订单号不一致拒绝、已支付不能重复支付、过期订单拒绝、无效签名拒绝、敏感头不进入日志。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm.cmd run test:billing -- tests/billing/payment-service.test.ts tests/billing/webhooks.test.ts`

- [ ] **Step 3: 实现支付服务和 webhook handler**

Webhook 必须先 `request.text()` 保留原始载荷，再验签和解析。事务 RPC 是唯一可将订单变为 PAID 并发放权益的入口。

- [ ] **Step 4: 运行测试与提交**

Expected: PASS。

Commit: `feat: add idempotent payment settlement`

### Task 7: 订阅、权益、额度和科研任务统一服务

**Files:**
- Create: `lib/billing/subscriptions.ts`
- Create: `lib/billing/entitlements.ts`
- Create: `lib/billing/usage-quota.ts`
- Create: `lib/billing/credits.ts`
- Create: `lib/billing/research-usage.ts`
- Create: `tests/billing/subscriptions.test.ts`
- Create: `tests/billing/credits.test.ts`
- Create: `tests/billing/research-usage.test.ts`

**Interfaces:**
- Produces classes: `SubscriptionService`, `EntitlementService`, `UsageQuotaService`, `CreditService`
- Produces: `ResearchUsageService.run(input, task)`

- [ ] **Step 1: 写会员与额度失败测试**

覆盖支付成功开月/月年会员、Credit Pack 加额度、重复通知不重复发放、会员到期、权益拒绝、额度不足、原子扣减、并发扣减不为负、任务失败返还、重复失败不重复返还。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm.cmd run test:billing -- tests/billing/subscriptions.test.ts tests/billing/credits.test.ts tests/billing/research-usage.test.ts`

- [ ] **Step 3: 实现统一服务**

`ResearchUsageService.run` 顺序固定为认证后的权限检查、周期限额、原子预占、执行、确认；catch/finally 中按任务状态释放预占。

- [ ] **Step 4: 运行测试与提交**

Expected: PASS。

Commit: `feat: add subscription and credit services`

### Task 8: 接入现有 AI API

**Files:**
- Modify: `app/api/chat/route.ts`
- Modify: `app/api/context-chat/route.ts`
- Modify: `app/api/cite/route.ts`
- Modify: `app/api/concept-explorer/ai/route.ts`
- Modify: `app/api/extract/route.ts`
- Modify: `app/api/generate-latex/route.ts`
- Modify: `app/api/keywords/route.ts`
- Modify: `app/api/literature-review/route.ts`
- Modify: `app/api/data-clean/route.ts`
- Modify: `app/api/papers/search/route.ts`
- Modify: `app/api/profile/summarize/route.ts`
- Modify: `app/api/summarize/route.ts`
- Modify: `app/api/polish/route.ts`
- Modify: `app/api/translate/route.ts`
- Modify: `app/api/ppt/generate-content/route.ts`
- Modify: `app/api/ppt/generate-section/route.ts`
- Create: `tests/billing/ai-route-integration.test.ts`

**Interfaces:**
- Consumes: `ResearchUsageService.run`
- Removes direct paid-path use of `checkUsageLimit` / `insertUsageRecord`

- [ ] **Step 1: 写静态集成失败测试**

断言目标 API 统一导入科研用量服务，并且不复制 `isVip`、套餐邮箱白名单或直接操作额度表。

- [ ] **Step 2: 逐个 API 以最小包装接入**

保留原始业务任务和流式响应；每个请求生成稳定任务 ID。流式任务只有完整结束才确认，连接中断和 Provider 错误释放预占。

`app/api/translate-page/route.ts` 因主工作区存在未提交用户修改，本阶段暂不修改；待用户修改提交/合并后单独协调接入，避免覆盖。

- [ ] **Step 3: 运行定向测试与提交**

Run: `npm.cmd run test:billing -- tests/billing/ai-route-integration.test.ts`

Expected: PASS。

Commit: `feat: enforce unified ai usage billing`

### Task 9: 用户账单、定价与售后页面

**Files:**
- Create: `app/pricing/page.tsx`
- Create: `app/checkout/[productId]/page.tsx`
- Create: `app/billing/page.tsx`
- Create: `app/billing/orders/[id]/page.tsx`
- Create: `app/billing/payment-result/page.tsx`
- Create: `app/api/billing/summary/route.ts`
- Create: `app/api/billing/refunds/route.ts`
- Create: `app/api/billing/invoices/route.ts`
- Modify: `components/AppShell.tsx`
- Modify: `components/Sidebar.tsx`
- Create: `tests/billing/user-pages.test.ts`

**Interfaces:**
- Consumes public products and authenticated billing summary APIs
- Produces hidden user navigation and forms

- [ ] **Step 1: 写页面与开关失败测试**

断言价格来自 API/数据库而非 JSX 常量；未勾协议不能提交；功能关闭时侧栏无购买入口且 API 拒绝；production Mock 普通用户看到“暂未开放”而不是支付按钮。

- [ ] **Step 2: 实现用户页面**

页面显示订单、套餐、额度、使用记录、退款和发票状态。Mock 确认按钮只对允许的测试用户渲染。

- [ ] **Step 3: 运行测试与提交**

Commit: `feat: add hidden billing user pages`

### Task 10: 管理后台与审计

**Files:**
- Create: `app/admin/billing/page.tsx`
- Create: `app/admin/billing/orders/page.tsx`
- Create: `app/admin/billing/users/[id]/page.tsx`
- Create: `app/admin/billing/refunds/page.tsx`
- Create: `app/admin/billing/invoices/page.tsx`
- Create: `app/admin/billing/webhooks/page.tsx`
- Create: `app/api/admin/billing/**/route.ts`
- Create: `lib/billing/admin.ts`
- Create: `tests/billing/admin.test.ts`

**Interfaces:**
- Consumes: `requireBillingAdmin`, `billing_adjust_credit`
- Produces audited plan/product/order/subscription/credit/refund/invoice operations

- [ ] **Step 1: 写管理员权限与审计失败测试**

覆盖普通用户所有管理接口 403、管理员可查询、人工额度调整/开会员必须有非空原因、每次变更写审计日志、不能修改已支付订单金额。

- [ ] **Step 2: 实现管理 API 和页面**

所有写操作先授权，再执行事务 RPC，最后返回审计 ID。页面不显示支付密钥或完整 webhook 敏感载荷。

- [ ] **Step 3: 运行测试与提交**

Commit: `feat: add billing admin tools`

### Task 11: 法律页面与主体占位配置

**Files:**
- Create: `lib/legal/config.ts`
- Create: `app/legal/terms/page.tsx`
- Create: `app/legal/privacy/page.tsx`
- Create: `app/legal/membership/page.tsx`
- Create: `app/legal/refunds/page.tsx`
- Create: `app/legal/ai-use/page.tsx`
- Create: `app/legal/academic-integrity/page.tsx`
- Create: `app/legal/invoices/page.tsx`
- Create: `app/legal/support/page.tsx`
- Create: `tests/billing/legal-pages.test.ts`

**Interfaces:**
- Produces: `getLegalOperatorConfig()`

- [ ] **Step 1: 写法律内容失败测试**

断言运营主体不硬编码；包含科研辅助、禁止代写/伪造数据/作弊/学术不端、AI 可能出错、用户核查引用数据结论、律师审核提示。

- [ ] **Step 2: 实现页面和安全占位**

环境变量为空时显示“运营主体信息待依法确认”，不得填入备案变更中的新主体。

- [ ] **Step 3: 运行测试与提交**

Commit: `feat: add billing legal drafts`

### Task 12: 全量安全回归、文档和交付验证

**Files:**
- Create: `tests/billing/security-coverage.test.ts`
- Create: `docs/billing-setup.md`
- Create: `docs/billing-security.md`
- Create: `docs/billing-rollback.md`
- Modify: `README.md`

**Interfaces:**
- Produces operator setup, test migration, provider prerequisites and rollback documentation

- [ ] **Step 1: 建立需求矩阵测试**

将用户要求的 20 项核心安全场景逐项映射到具体测试名称；静态断言备案和部署文件与分支基点 `1138955` 内容一致。

- [ ] **Step 2: 编写文档**

说明默认关闭、Mock 白名单、环境变量、测试数据库迁移、微信所需商户号/AppID/API v3 key/商户私钥/证书序列号/回调域名、支付宝所需 AppID/应用私钥/支付宝公钥/回调与返回地址。不得加入真实值。

回滚流程为：关闭 `BILLING_FEATURE_ENABLED`、停止新订单、保留账务历史、回滚应用代码；数据库 migration 首期采用向前修复，不删除账务数据。

- [ ] **Step 3: 运行最终验证**

```powershell
npm.cmd test
npm.cmd run typecheck
npx.cmd eslint lib/billing app/api/billing app/api/admin/billing app/pricing app/checkout app/billing app/admin/billing app/legal tests/billing
npm.cmd run build
git diff --check main...HEAD
git diff --name-only main...HEAD
```

Expected: 全部命令退出码 0；文件清单不含备案、部署及用户未提交的翻译文件。

- [ ] **Step 4: 提交文档和测试**

Commit: `test: add billing security coverage`

Commit: `docs: add billing setup guide`

- [ ] **Step 5: 最终报告但不部署**

报告修改摘要、文件清单、migration、环境变量、测试/类型/Lint/Build 结果、备案文件状态、功能隐藏方式、微信/支付宝资料、回滚方式和未完成事项。不得 push 或部署。
