# 收费快速上线验收基线

当前快速上线范围仅包含一次性购买，不包含自动续费或自动扣款。

## 目录契约

- `FREE` 是默认免费套餐，不创建零元购买商品。
- `PRO_MONTHLY` 可保留为后台配置，但必须保持 `is_active=false`，不进入首发可售目录。
- `PRO_SEMESTER` 的后端配置为 7900 分 CNY、150 天、`pro-semester-v1` 权益；套餐额度为免费套餐对应额度的五倍。
- `CREDIT_PACK_100` 的后端配置为 990 分 CNY、100 credits、`credit-v1` 权益。
- 不创建 `PRO_YEARLY` 商品。
- 预发布期间所有商品保持 `is_active=false`，因此公开商品接口返回空目录。

价格、期限、额度和权益版本由数据库及服务端目录提供，定价页和结算页不得嵌入这些业务数值。创建订单时必须重新读取可用商品，并把服务端价格、币种和权益写入不可变订单快照；客户端金额和币种不参与定价。

## 激活门禁

管理员对停用商品的维护仍被允许。尝试将商品设为启用时，服务端同时要求：

1. `BILLING_FEATURE_ENABLED=true`；
2. SKU 只能是 `PRO_SEMESTER` 或 `CREDIT_PACK_100`；
3. 商品类型、价格、期限、额度和权益版本与上述批准目录完全一致。

`PRO_MONTHLY`、`PRO_YEARLY`、`FREE` 或其他 SKU 均不得通过管理员服务激活。前端隐藏按钮不是安全边界，激活限制由服务端执行。

## 当前发布状态

Stage B 标记为 `PARTIAL`：第二托管项目和本地 Docker 恢复演练暂缓。该欠账不阻塞 Stage C–F，但任何生产数据库迁移前仍必须完成生产备份、备份可读性检查、迁移顺序确认、回滚条件确认和单独审批。

当前不授权推送 `main`、部署、连接生产数据库、启用真实支付或公开购买入口。

## 微信支付 Stage D1 配置材料

默认值必须继续保持：

```text
BILLING_FEATURE_ENABLED=false
PAYMENT_MODE=mock
```

只有进入另行批准的微信商户测试时，服务端才可选择 `PAYMENT_MODE=wechat`。微信 Native 支付的共同必需变量名如下；真实值只能注入受控的服务端密钥存储，不得写入仓库、日志或客户端环境变量：

```text
WECHAT_PAY_MCH_ID
WECHAT_PAY_APP_ID
WECHAT_PAY_API_V3_KEY
WECHAT_PAY_PRIVATE_KEY
WECHAT_PAY_CERT_SERIAL_NO
WECHAT_PAY_NOTIFY_URL
```

`WECHAT_PAY_PRIVATE_KEY` 与兼容别名 `WECHAT_PAY_MCH_PRIVATE_KEY` 只能提供一个有效值；`WECHAT_PAY_CERT_SERIAL_NO` 与 `WECHAT_PAY_MCH_SERIAL_NO` 同理。若同时提供规范名和别名，两者必须完全一致，否则服务端拒绝启动。回调 URL 必须是可由微信访问的 HTTPS 地址。

响应与回调验签必须从下面两种模式中选择且只选择一种：

1. 微信支付公钥模式：同时提供 `WECHAT_PAY_PUBLIC_KEY_ID` 和 `WECHAT_PAY_PUBLIC_KEY`，前者是微信支付公钥 ID，后者是对应 PEM 公钥。
2. 平台证书模式：提供 `WECHAT_PAY_PLATFORM_CERT`，内容为微信支付平台证书 PEM；服务端从证书读取并匹配平台证书序列号。

两种验签材料不得混用。商户侧后续仍需从微信商户平台受控取得并复核：商户号、已绑定的应用 ID、32 字节 API v3 密钥、商户 API 证书私钥及证书序列号，以及所选验签模式对应的微信支付公钥/公钥 ID或平台证书。还需准备受控 HTTPS 回调域名和路径；Stage D1 仓库不包含任何真实材料。

## 离线验证

Stage D1 的签名、验签、加密回调和退款测试全部使用进程内生成的测试密钥与确定性 fake transport，不连接微信、数据库或外部网络。定向验收命令为：

```powershell
npm.cmd exec -- tsx --test tests/billing/wechat-crypto.test.ts tests/billing/wechat-transport.test.ts tests/billing/wechat-provider.test.ts tests/billing/payment-service.test.ts tests/billing/webhooks.test.ts tests/billing/refund-execution.test.ts tests/billing/security-coverage.test.ts
```

离线生产构建使用 Next 提供的 `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` 测试钩子，避免构建机访问 Google Fonts：

```powershell
$env:NEXT_FONT_GOOGLE_MOCKED_RESPONSES = (Resolve-Path "tests/fixtures/next-font-google-responses.cjs").Path
npm.cmd run build
```

该变量和 fixture 仅用于离线构建门禁：它以本地字体 CSS 响应验证编译、类型生成和路由契约，不修改 `app/layout.tsx`，也不替代生产构建对 Geist 字体下载/缓存及最终页面字体的验证。部署流程不得设置这个测试变量，除非另有独立审核批准。

## 后续独立批准

完成 Stage D1 不会启用真实支付。以下每一项都必须分别提出、审查并获批，不能由其中一项的批准推定其他项也获批：

- Stage D2 微信沙箱或受控商户测试；
- 注入任何真实商户凭据、API v3 密钥、私钥、公钥或平台证书；
- 将 `PAYMENT_MODE` 切换为 `wechat`；
- 执行任何生产数据库迁移；
- 推送或部署支付相关变更；
- 发起内部真实金额支付或退款；
- 将商品、套餐或公开购买入口激活。
