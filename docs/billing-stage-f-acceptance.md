# Stage F 预发布验收清单

本文只定义预发布准备与验收门禁，不授权部署生产、连接生产数据库、启用真实支付、启用公开购买、推送 `main` 或执行生产迁移。

## 1. 环境边界

预发布环境必须满足：

- 使用独立预发布域名；不得复用线上域名执行收费验收。
- Supabase Project Ref 必须由负责人明确批准，并不得出现在 `BILLING_PRODUCTION_PROJECT_REFS` 中。
- `NEXT_PUBLIC_SUPABASE_URL`、Anon Key 和 Service Role Key 必须全部属于同一个预发布项目。
- Service Role Key 只进入服务端密钥存储，不进入客户端变量、仓库、截图、日志或工单。
- 不配置微信、支付宝或其他真实支付凭据。
- 不修改 ICP、公网安备、备案图标、备案链接、域名、Nginx、DNS、SSL 或生产部署配置。

关闭态配置固定为：

```dotenv
NODE_ENV=production
BILLING_FEATURE_ENABLED=false
PAYMENT_MODE=mock
BILLING_REAL_PAYMENT_PUBLIC_ENABLED=false
BILLING_TEST_USER_IDS=<逗号分隔的 Supabase Auth 用户 UUID>
BILLING_STAGE_F_PROJECT_REF=<预发布 Supabase Project Ref>
BILLING_PRODUCTION_PROJECT_REFS=<逗号分隔的生产 Project Ref>
```

`BILLING_TEST_USER_IDS` 只接受明确、唯一的 Supabase Auth UUID，不接受邮箱、`*`、`all` 或 `public`。在 `BILLING_FEATURE_ENABLED=false` 时，管理员和白名单账号同样不能购买；白名单只是为另行批准的受控 Mock 窗口预先配置。

运营信息必须使用已经确认的合法值：

```dotenv
LEGAL_OPERATOR_NAME=<已确认运营主体>
LEGAL_OPERATOR_CREDIT_CODE=<统一社会信用代码>
LEGAL_CONTACT_EMAIL=<正式客服或投诉邮箱>
```

法律页面仍是待律师审核的初稿时，只能用于内部预发布审阅，不能据此批准公开收费。

## 2. 静态安全预检

在预发布服务器准备好环境变量后，从隔离分支工作目录执行：

```powershell
npm.cmd exec -- tsx scripts/billing-stage-f-preflight.ts
```

预检器只读取进程环境，不访问网络或数据库，不部署、不迁移、不写入文件。成功时必须同时满足：

- `ok=true`；
- `profile=STAGE_F_CLOSED_MOCK`；
- Project Ref 与预发布 Supabase URL 完全一致；
- Project Ref 不属于生产项目；
- 白名单至少包含一个合法且不重复的 UUID；
- 法律运营信息完整；
- 所有微信和支付宝配置为空。

失败输出只包含固定错误码和非敏感计数，不包含密钥值。预检失败不得继续部署预发布环境。

## 3. 预发布配置模板

仓库中的 `deploy/staging/` 只包含未激活模板，提交模板不等于授权执行：

- `environment.example`：固定测试/生产 Project Ref、测试 UUID 和关闭态开关；所有真实密钥与运营信息值留空。获批后在服务器受控填写，并保存为 `/var/www/ai-research-assistant-staging/.env.local`，权限必须为 `600` 或 `400`。
- `ecosystem.config.cjs`：PM2 进程固定为 `ai-research-staging`，目录固定为 `/var/www/ai-research-assistant-staging`，Next 只监听 `127.0.0.1:3001`。
- `deploy.sh`：只接受 `codex/billing-mvp` 和干净的 tracked worktree；不拉取、不重置、不切换代码，不操作生产进程；安装依赖后必须先通过环境预检和构建，才会启动或重载预发布 PM2。
- `nginx-staging.conf.example`：未激活的 HTTP 示例，域名固定为 `staging.iyanhub.com`，只代理到 `127.0.0.1:3001`；默认仅允许服务器本机访问，不包含 SSL、证书申请或生产配置修改。

在 DNS、访问来源、SSL 和服务器变更分别获批之前，不得复制或启用 Nginx 示例。当前生产 `deploy.sh` 会同步 `main` 并重启生产进程，禁止用于 Stage F。

## 4. F1：关闭态验收

F1 全程保持 `BILLING_FEATURE_ENABLED=false`，所有套餐与商品保持 `is_active=false`。

### 用户侧

- [ ] 首页、登录、退出和现有科研功能正常。
- [ ] `/pricing` 不显示可购买商品或购买按钮。
- [ ] `/billing`、订单页和支付结果页不暗示用户已经支付或已获得会员。
- [ ] 普通用户、管理员和白名单账号创建订单均被服务端拒绝。
- [ ] 创建支付、Mock 确认、退款和发票写请求均被服务端拒绝。
- [ ] 已有账单只读查询仅返回当前登录用户的数据。

### 管理侧

- [ ] 未登录和普通用户无法访问管理页面及管理 API。
- [ ] 服务端确认的管理员可以查看订单、支付、退款、发票、会员、权益、额度、回调和内部对账。
- [ ] 只读对账不自动修改订单、支付、退款、订阅、权益、额度或流水。
- [ ] 管理员不能在收费关闭时激活套餐或商品。

### 日志与隐私

- [ ] 日志不包含 Service Role Key、商户密钥、私钥、完整签名或原始 webhook。
- [ ] 发票和管理视图不暴露完整税号或完整投递邮箱。
- [ ] 固定安全事件只记录允许的 Provider、订单号、事件 ID、状态和错误码。

F1 通过只证明“代码可以在收费关闭状态安全运行”，不证明 Mock 购买链路或真实支付已经通过预发布验收。

## 5. F2：受控 Mock 全链路

F2 不在当前授权范围内。开始前必须另行批准以下全部动作：

1. 仅在预发布环境临时设置 `BILLING_FEATURE_ENABLED=true`；
2. 仅在预发布数据库临时激活 `PRO_SEMESTER` 和 `CREDIT_PACK_100`；
3. 仅允许管理员和 `BILLING_TEST_USER_IDS` 执行 Mock 购买；
4. 验收结束立即恢复 `BILLING_FEATURE_ENABLED=false` 并停用全部商品。

批准后需要验证：

### Pro Semester

- [ ] 服务端价格为 7900 分 CNY，有效期 150 天，权益版本为 `pro-semester-v1`。
- [ ] 13 项周期额度均为停用的 `PRO_MONTHLY`（`pro-v1`）对应额度的五倍。
- [ ] 客户端伪造价格、币种、期限和额度均无效。
- [ ] 支付成功只创建一次订阅、权益和额度周期。
- [ ] 重复确认、重复回调和并发结算不重复发放权益。
- [ ] 科研任务成功扣减，失败按规则返还；并发扣减不产生负数。
- [ ] 未使用套餐按批准规则退款；已使用套餐进入限制或人工处理。

### Credit Pack 100

- [ ] 服务端价格为 990 分 CNY，成功后只增加一次 100 credits。
- [ ] 重复通知不重复增加额度。
- [ ] 额度不足时任务不会执行。
- [ ] 额度包退款进入人工审核，不自动猜测或回收余额。

### 售后与运营

- [ ] 退款申请、审核、执行和失败重试均有审计记录。
- [ ] 发票申请、查看和状态更新不泄露敏感字段。
- [ ] 人工调整额度和人工开通会员必须填写原因并保持幂等。
- [ ] 验收产生的订单、回调、退款、发票和审计数据有明确清理/保留决定。

## 6. 自动化门禁

每次 Stage F 候选提交执行：

```powershell
npm.cmd run test:billing
npm.cmd run typecheck
npm.cmd run lint -- scripts/billing-stage-f-preflight.ts tests/billing/stage-f-preflight.test.ts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/fixtures/run-next-build-offline.ps1
git diff --check
```

数据库验收只在获得具体测试项目授权后执行。必须核对 Project Ref、001–016 迁移一致、`db push --dry-run` 无待执行项、完整 `verify.sql` 最终回滚、无合成数据残留、关键触发器启用且内部函数权限关闭。不得把测试项目授权解释为生产数据库授权。

## 7. 法律、监控和依赖门禁

以下任何一项未完成，Stage F 只能标记为 `PARTIAL`：

- [ ] 律师批准正式用户协议、隐私政策、会员服务协议和退款政策。
- [ ] 运营主体、统一社会信用代码和客服投诉邮箱已确认。
- [ ] 当班、升级、财务对账和安全负责人已填写。
- [ ] 告警接收渠道、首次响应、升级和复盘时限已批准。
- [ ] 无效签名、失败支付、滞留回调、金额冲突和账务差异的阈值已配置并测试。
- [ ] 依赖风险已修复，或由负责人书面接受并记录缓解措施和复查日期。
- [ ] 生产迁移前备份方式、可读性验证、迁移顺序和回滚条件已批准。

## 8. 停止与回滚条件

出现以下任一情况立即保持或恢复 `BILLING_FEATURE_ENABLED=false`：

- 身份、项目 Ref 或环境变量来源不确定；
- 普通用户能看到或调用购买入口；
- 金额、币种、订单号或 Provider 状态不一致；
- 重复结算导致重复会员、权益或额度；
- 余额出现负数或账务流水缺失；
- 日志泄漏密钥、签名、原始回调、完整税号或邮箱；
- 回调、退款或对账出现无法解释的状态；
- 自动化测试、类型检查、Lint、构建或数据库验收任一失败。

回滚不得删除账务数据或反向执行已应用迁移。应用代码回滚后仍保持收费关闭，数据库问题采用新的前向修复迁移。

## 9. 签字记录

| 门禁 | 结果 | 证据位置 | 审核人 | 时间 |
| --- | --- | --- | --- | --- |
| 静态安全预检 | 未执行 |  |  |  |
| F1 关闭态 | 未执行 |  |  |  |
| F2 Mock 全链路 | 未授权 |  |  |  |
| 自动化测试 | 未执行 |  |  |  |
| 法律审核 | 未完成 |  |  |  |
| 监控与值守 | 未完成 |  |  |  |
| 依赖风险 | 未接受 |  |  |  |
| 备份与回滚 | Stage B PARTIAL |  |  |  |

只有全部必需门禁有证据且经单独批准，Stage F 才能标记为 `PASS`。Stage F 通过也不自动授权生产部署、生产迁移、真实支付或公开购买。
