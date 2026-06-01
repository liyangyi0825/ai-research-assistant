# TASK_LOGIN_AND_USAGE_LIMITS.md — 用户登录 + 用量限制

> 这份文件交给 Claude Code 执行。请先读完全文了解整体目标，再按"分步执行计划"
> 一步步实施。每一步做完停下来等用户测试通过，再做下一步。

---

## 背景

目前网站没有用户登录系统，任何人拿到链接都能无限调用 AI——一旦开放给真实用户，
存在被恶意刷量、一夜烧光 API 额度的风险。这是开放给陌生用户之前**必须**先解决的
"生存底线"问题，不是功能特性，是基础设施。

完成这件事之后，网站才能开放给陌生人测试和使用。

---

## 整体目标

为网站添加完整的"用户登录 + 用量限制 + 后台监控"系统，使得：

1. 所有 AI 功能（论文总结、对话）**必须登录后才能使用**，未登录用户跳转到登录页
2. 每个用户的使用量受**自动配额限制**，避免单用户烧光额度
3. 每次 AI 调用都被记录，方便日后审计和分析
4. 提供一个简单的内部监控页面，让我（项目所有者）能随时了解运营状态

---

## 技术栈（保持和现有项目一致）

- **认证 + 数据库**：Supabase（如果还没接入，这次接入）
- **登录方式**：邮箱 + Magic Link（无密码登录，发邮件链接登录）
- **配额限制**：在调用 Claude API 前查询数据库判断
- **缓存优化**：Anthropic Prompt Caching（对话功能省钱的关键）

---

## 数据库结构（在 Supabase 中创建）

### 表 1：`usage`（用量记录表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid | 主键 |
| user_id | uuid | 关联 auth.users |
| action_type | text | 'summary' 或 'chat' |
| tokens_input | int | 输入 token 数 |
| tokens_output | int | 输出 token 数 |
| cost_usd | numeric | 估算费用（按当前 Claude Sonnet 4.6 单价计算）|
| created_at | timestamptz | 创建时间，默认 now() |

需要在 user_id 上建索引以加速查询。

### 表 2：`feedback`（顺便预留，后续要用）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid | 主键 |
| user_id | uuid | 关联 auth.users（可空，未登录用户也能反馈）|
| content | text | 反馈内容 |
| screenshot_url | text | 可选 |
| created_at | timestamptz | 创建时间 |

---

## 用量限制规则（写成可配置常量，放在 `lib/limits.ts`）

```typescript
// 免费用户每月配额
export const FREE_MONTHLY_LIMITS = {
  summary: 5,    // 每月最多总结 5 篇论文
  chat: 30,      // 每月最多 30 次对话
};

// 计费周期：每月 1 号 00:00 重置（按用户所在时区或 UTC，先用 UTC 简单点）
```

---

## 分步执行计划

⚠️ **重要**：每一步做完后**停下来**，告诉用户怎么测试，等用户确认通过再做下一步。
不要把所有步骤一口气做完。

### 步骤 1：接入 Supabase

1. 如果项目还没装 `@supabase/supabase-js`，装上
2. 创建 `lib/supabase.ts`，封装 Supabase 客户端（区分 server 端和 client 端）
3. 提示用户去 supabase.com 创建项目（区域选 Singapore 或 Tokyo），把
   `NEXT_PUBLIC_SUPABASE_URL` 和 `NEXT_PUBLIC_SUPABASE_ANON_KEY` 填进 `.env.local`
4. 提示用户在 Supabase SQL 编辑器执行建表 SQL（你给出具体 SQL）

**测试**：用户能从 .env.local 读到 Supabase 配置，项目能成功初始化客户端。

---

### 步骤 2：邮箱 Magic Link 登录

1. 创建 `/login` 页面：一个输入邮箱 + "发送登录链接"按钮的简洁页面
2. 调用 Supabase Auth 的 `signInWithOtp`，发送 Magic Link 邮件
3. 创建 `/auth/callback` 路由处理回调
4. 用户点击邮件链接后，登录成功，跳转回首页
5. 在导航栏右上角显示当前登录邮箱 + "退出登录"按钮
6. 在 `middleware.ts` 中保护需要登录的路由（首页 / 上传 / 总结 / 对话）
   未登录访问这些页面 → 自动跳转到 `/login`

**测试**：
- 未登录时访问首页 → 跳转到登录页
- 输入邮箱 → 收到登录邮件
- 点链接 → 登录成功 → 看到导航栏邮箱

---

### 步骤 3：用量记录

1. 在 `/api/summarize` 和 `/api/chat`（或类似的 API 路由）中，
   每次 Claude API 调用成功后，往 `usage` 表写入一条记录
2. 字段填：当前 user_id、action_type、Claude 返回的 input/output token、估算的费用
3. 写入失败不应阻断主流程（用 try/catch 包好），但要打日志

**测试**：用户上传一篇论文 → 在 Supabase 后台 `usage` 表能看到一条新记录。

---

### 步骤 4：用量限制

1. 创建 `lib/limits.ts`，定义 `FREE_MONTHLY_LIMITS` 常量
2. 创建工具函数 `checkUsageLimit(userId, actionType)`：
   - 查询 `usage` 表中该用户**本月**（当前 UTC 月份的 1 号 00:00 至今）
     的 actionType 调用次数
   - 如果 ≥ 限制，返回 `{ allowed: false, used, limit }`
   - 否则返回 `{ allowed: true, used, limit }`
3. 在每个 AI API 路由的开头调用这个函数
4. 超额时返回 HTTP 429 + 友好中文错误信息：
   "本月免费额度已用完（已用 X/Y），下月 1 号自动重置"
5. 前端捕获这个错误，弹出友好提示，不要让页面崩溃

**测试**：
- 把限制临时改成 1 次
- 用一次正常
- 用第二次 → 看到友好的"额度用完"提示
- 改回 5 / 30

---

### 步骤 5：Prompt Caching（省钱关键，必做）

1. 修改"和论文对话"的 API 调用，使用 Anthropic 的 `cache_control`:
   - 将论文正文部分标记为缓存（`cache_control: { type: "ephemeral" }`）
   - 用户的本次问题作为非缓存部分
2. 参照 Anthropic 官方文档：https://docs.claude.com 搜索 "prompt caching"
3. 修改后端记录 `usage` 表时，区分 cached / non-cached tokens 的费用

**测试**：
- 同一篇论文连续问两个问题
- 第二次回复应该明显更快
- usage 表里的 cost_usd 第二次应该显著降低

---

### 步骤 6：内部监控页

1. 创建 `/admin/usage` 页面
2. 进入前校验：当前登录用户的 email 是否等于 `process.env.ADMIN_EMAIL`
   不匹配 → 显示 403 页面
3. 页面展示三块内容：
   - 今日：总调用次数 + 今日费用
   - 本月：总调用次数 + 本月费用
   - Top 10 用户：按本月调用次数排序，显示邮箱 / summary 次数 / chat 次数 / 费用
4. 提示用户把自己的邮箱填进 `.env.local` 的 `ADMIN_EMAIL` 变量

**测试**：
- 用 ADMIN_EMAIL 登录 → 能看到数据
- 用其他账号登录 → 看到 403

---

## ⚠️ 必须遵守的约束

1. **安全**：所有 Supabase / Anthropic key 只放 `.env.local`，绝不写死在代码里，
   绝不提交到 Git。前端不调用任何需要密钥的 API。
2. **错误处理**：任何 API 调用失败都要给用户友好的中文提示，不要让页面崩溃或
   显示英文报错。
3. **不破坏现有功能**：现有的"上传论文 + 总结 + 对话"流程必须保持工作，
   只是前面加了登录闸门、调用前后加了配额检查和记录。
4. **沟通方式**：用户没有编程基础，请用通俗中文解释每一步在做什么；
   遇到选择题先列出选项让用户选。

---

## 完成本任务后用户拥有什么

- 完整的邮箱登录系统
- 自动用量限制（单用户烧不出大账单）
- 全量调用记录（可审计、可分析)
- 对话功能成本下降 80%+（缓存)
- 一个监控仪表盘
- **可以放心把网站开放给陌生人使用**

这是 MVP → 公测产品的关键过渡。
