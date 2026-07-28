# Task 9 Report: 隐藏态用户账单、定价与售后页面

## 完成范围

- 新增独立页面：
  - `/pricing`
  - `/checkout/[productId]`
  - `/billing`
  - `/billing/orders/[id]`
  - `/billing/payment-result`
- 新增只读可用性、账单摘要、退款申请和发票申请 API。
- 新增 focused billing components，并以“科研资源刻度”展示套餐有效期、credits 与 quota。
- `AppShell` 将 billing/pricing/checkout 作为独立路由渲染，不挂载科研 SPA tabs。
- `Sidebar` 仅在 `/api/billing/availability` 明确返回可用时显示“账单与额度”，初始态与异常态均隐藏。

## 安全与业务边界

- 默认 `BILLING_FEATURE_ENABLED=false` 时，定价、结账与支付结果页仅显示“收费功能暂未开放”，不显示购买或 Mock 确认动作。
- production + Mock 下，普通用户的 availability fail-closed；仅管理员或测试白名单可看到购买与 Mock 测试动作，写 API 仍执行服务端权限校验。
- 产品名称、价格、有效期、credits 与展示权益均来自 `/api/billing/products`/数据库；前端创建订单只提交 `productId`、服务端公开的 provider 和协议版本，不提交金额、币种或用户 ID。
- 退款与发票接口先执行服务端认证，再校验订单所有权和状态；申请金额与币种只从本人订单读取。
- 退款和发票首期均只创建申请，不执行自动退款，也不伪造已开票状态。
- 两类申请增加 `(user_id, order_id)` 唯一约束，并使用 `upsert onConflict` 后按本人订单重读，避免 search-then-insert 并发竞态。
- 输入执行精确字段、枚举、长度、税号和邮箱校验；数据库与未知错误统一 fail-closed，不向页面泄露原始错误。

## TDD 证据

- 初始 RED：定向测试共 44 项，其中 13 项因页面、组件、route、AppShell 接线和唯一约束尚不存在而失败。
- 实现后 GREEN：定向测试 44/44 通过。
- 覆盖默认隐藏、production Mock 白名单、服务端身份与所有权、服务端派生金额、申请幂等、数据库 fail-closed、独立 AppShell 路由和 Sidebar fail-closed。

## 验证

- 定向测试：44/44 通过。
- `npm.cmd run test:billing`：183/183 通过。
- `npm.cmd test`：186/186 通过。
- `npm.cmd run typecheck`：通过。
- 目标 ESLint：通过。
- `npm.cmd run build`：生产构建通过，生成 66 个页面。
  - 首次在受限网络内因现有 `app/layout.tsx` 的 Geist/Geist Mono 无法从 Google Fonts 下载而失败。
  - 允许联网后同一构建命令通过；仍有仓库既有的多 lockfile、`middleware` 弃用和 edge 静态化警告。
- 桌面与 390px 移动端视觉复核：默认关闭态无购买入口，布局无横向溢出。
- `git diff --check`：通过。

## 明确未触碰

- 未修改备案 footer、根 layout、管理后台、法律页面或部署配置。
- 未连接或迁移线上数据库，未 push，未 deploy。
- 迁移文件只增加退款/发票申请的复合唯一约束；没有执行数据库部署。
