# 收费 MVP 配置与测试指南

> 当前收费功能仅供本地、独立测试环境及获准测试账号使用。备案主体变更完成且业务、法务、安全评审通过前，不得正式收费。

## 安全默认值

```dotenv
BILLING_FEATURE_ENABLED=false
PAYMENT_MODE=mock
BILLING_TEST_USER_IDS=
BILLING_REAL_PAYMENT_PUBLIC_ENABLED=false
```

- `BILLING_FEATURE_ENABLED=false` 时不展示公开购买入口，创建订单、创建支付、Mock 确认及售后写接口拒绝访问；已付款订单的已验签支付回调仍会继续结算，避免商户扣款后未发放权益。
- 此功能开关不是支付回调硬停开关。需要硬停 Provider 时，必须使用独立、经审批的运维机制并保留对账与人工处置路径。
- `PAYMENT_MODE=mock` 只用于本地、测试环境，以及生产环境中明确列入 `BILLING_TEST_USER_IDS` 的测试账号或服务端确认的管理员。
- `PAYMENT_MODE=wechat` 默认同样只允许服务端确认的管理员或 `BILLING_TEST_USER_IDS` 白名单账号。只有另行批准公开真实支付后，才可显式设置 `BILLING_REAL_PAYMENT_PUBLIC_ENABLED=true`；默认 `false`，且订单、支付创建和可用性接口都在服务端执行该门禁。
- 生产环境不能将 Mock 支付公开给普通用户。程序启动和每次支付访问都会执行安全校验。
- 根目录 `instrumentation.ts` 的 `register()` 会在 Next.js 服务实例就绪前调用 Billing 启动校验；默认关闭配置可正常构建和启动，不安全的生产 Mock 或缺少正式 Provider 配置会阻止实例就绪。
- 不要在仓库、数据库或日志中保存真实商户密钥。

## 环境变量

法律信息在备案和法律审核确认前应留空；页面使用中性占位符，不得擅自切换运营主体。

```dotenv
LEGAL_OPERATOR_NAME=
LEGAL_OPERATOR_CREDIT_CODE=
LEGAL_CONTACT_EMAIL=
```

微信支付预留配置：

```dotenv
WECHAT_PAY_MCH_ID=
WECHAT_PAY_APP_ID=
WECHAT_PAY_API_V3_KEY=
WECHAT_PAY_PRIVATE_KEY=
WECHAT_PAY_CERT_SERIAL_NO=
WECHAT_PAY_PLATFORM_CERT=
WECHAT_PAY_PUBLIC_KEY_ID=
WECHAT_PAY_PUBLIC_KEY=
WECHAT_PAY_NOTIFY_URL=
```

支付宝预留配置：

```dotenv
ALIPAY_APP_ID=
ALIPAY_PRIVATE_KEY=
ALIPAY_PUBLIC_KEY=
ALIPAY_NOTIFY_URL=
ALIPAY_RETURN_URL=
```

`WECHAT_PAY_PRIVATE_KEY` 是商户 RSA-2048 私钥，`WECHAT_PAY_CERT_SERIAL_NO` 是十六进制商户证书序列号。验签材料必须二选一：平台证书 `WECHAT_PAY_PLATFORM_CERT`，或完整的微信支付公钥 ID/PEM 对 `WECHAT_PAY_PUBLIC_KEY_ID`、`WECHAT_PAY_PUBLIC_KEY`。启动校验还会拒绝非 RSA-2048 密钥、过期或尚未生效的平台证书、非法商户号/AppID/序列号/公钥 ID。`ALIPAY_PRIVATE_KEY` 是支付宝应用私钥。旧变量 `WECHAT_PAY_MCH_PRIVATE_KEY`、`WECHAT_PAY_MCH_SERIAL_NO` 和 `ALIPAY_APP_PRIVATE_KEY` 仅作为兼容别名；若新旧变量同时设置且值不同，程序会拒绝启动收费功能。所有值只应通过受控的服务端密钥管理注入，日志不得输出其内容。

当 `PAYMENT_MODE=wechat` 或 `PAYMENT_MODE=alipay` 且收费功能开启时，缺少任一对应配置会拒绝启用支付功能。微信 Native Provider 已具备离线验证的创建、查询、关闭、退款和回调实现；支付宝 Provider 仍为失败关闭的接口骨架。错误信息不输出变量值。

## 独立测试数据库

只允许在本地 Supabase 或明确隔离、可销毁的测试数据库执行迁移。不得连接线上数据库，不得运行不可逆的生产迁移。

按文件名顺序应用：

1. `202607210001_billing_schema.sql`
2. `202607210002_billing_rls.sql`
3. `202607210003_billing_functions.sql`
4. `202607230004_billing_after_sales.sql`
5. `202607290005_billing_admin_functions.sql`
6. `202607290006_billing_admin_hardening.sql`
7. `202607290007_billing_admin_rpc_hardening.sql`
8. `202607290008_revoke_legacy_billing_credit_rpc.sql`
9. `202607290009_billing_feature_usage_costs.sql`
10. `202608050010_billing_catalog_seed.sql`
11. `202608120011_billing_fast_launch_catalog_guard.sql`
12. `202608160012_billing_refund_execution.sql`
13. `202608180013_billing_webhook_retry.sql`
14. `202608210014_wechat_native_payment_intents.sql`

### 2026-08-05 独立测试库验收记录

本记录对应独立、可销毁的 Supabase 测试项目 `fqnpzsecalhrsqhpdaxs`，不是生产数据库。仅记录公开 Project Ref；不要在本文、提交记录或日志中写入连接串、访问令牌或密钥。

- 已验收迁移 `001`–`010`，本地迁移目录与该测试项目的远程迁移记录一致。
- 已在该测试库验证真实 RPC 的额度并发预占、确认、失败返还及重复请求幂等；并验证支付结算重复回调不会重复入账，金额或币种不一致会被拒绝。
- 已验收目录数据：Free、Pro Monthly、Pro Semester、Credit Pack 100；Free 不创建零元商品，所有 Plan 与 Product 均保持 `is_active=false`，匿名用户不可见商品。
- 此验收不构成生产迁移、生产支付或公开销售授权。生产环境须另行完成备份、变更审批、回滚演练和上线验收。

本地 Supabase 可使用：

```powershell
supabase db reset
supabase migration up --local
```

迁移后运行：

```powershell
npm.cmd test
npm.cmd run typecheck
npx.cmd eslint lib/billing app/api/billing app/api/admin/billing app/pricing app/checkout app/billing app/admin/billing app/legal tests/billing
npm.cmd run build
```

本轮交付未连接真实 PostgreSQL/Supabase 实例，因此事务、锁、RLS 和并发 RPC 目前由静态 SQL 合约测试覆盖，正式进入测试环境前仍必须在独立 PostgreSQL 数据库验证。

## 正式启用微信支付所需资料

备案变更完成且获得明确上线授权后，至少准备：

- 微信支付商户号；
- 与业务场景匹配的 AppID，并完成商户号绑定；
- API v3 Key；
- 商户 API 证书私钥和证书序列号；
- 微信支付平台证书或平台公钥材料；
- 可通过 HTTPS 公网访问的支付回调域名和完整通知地址；
- 微信商户平台的产品权限、结算账户及必要审核；
- 用于验签、证书轮换和回调重放测试的测试流程。

`WechatPayProvider` 的代码级签名、验签、Native 创建/查询/关闭、退款和回调路径已通过离线 fake transport 测试，但这不等于商户联调或生产就绪。切换 `PAYMENT_MODE=wechat`、注入凭据、执行迁移、真实金额验证和公开购买仍分别需要审批。获准测试账号创建 Native 支付后，owner-authenticated 支付端点只向该订单所有者返回已验签 `code_url` 及本地生成、未持久化的 SVG data URL；浏览器不能自行确认成功，必须等待服务端验签查询或回调完成原子结算。

## 正式启用支付宝所需资料

备案变更完成且获得明确上线授权后，至少准备：

- 支付宝开放平台 AppID；
- 应用私钥；
- 支付宝公钥（证书模式下还需相应应用/支付宝根证书材料）；
- 可通过 HTTPS 公网访问的异步通知域名和完整回调地址；
- 经核准的同步返回地址；
- 已签约并审核通过的支付产品、结算信息；
- 签名算法、密钥轮换及回调重放测试流程。

当前 `AlipayProvider` 仅为失败关闭的接口骨架；未完成真实签名、请求和回调验签前不能切换 `PAYMENT_MODE=alipay`。
