# 每次 push 前必须检查的项目

> 发现问题立刻修好再 push，不要带着已知 bug 上线。

---

## 布局

- [ ] 管理员页面 `/admin/usage` 没有侧边栏
- [ ] 所有功能页面（上传、翻译、检索词等）有侧边栏
- [ ] 退出登录是纯文字，没有图标
- [ ] 右下角没有反馈浮动按钮（已移除 FeedbackWidget 入口）

## 论文总结

- [ ] 总结页面没有「全文翻译」按钮
- [ ] 总结页面没有「论文转 PPT」按钮
- [ ] 总结内容有正确的 Markdown 渲染（**加粗**、列表）
- [ ] 公式有 KaTeX 渲染
- [ ] 点击「新建分析」后页面清空（不残留上一篇论文内容）

## AI 对话

- [ ] 输出完成后 `#` 和 `*` 正确渲染为 Markdown（不显示原始符号）
- [ ] 长对话不会中途截断停止

## 用量限制

- [ ] 管理员账号（liyangyi0825@gmail.com）无限额度
- [ ] 所有 AI 功能（总结/对话/翻译/PPT/概念/检索词/综述）都有用量记录

## 页面刷新恢复

- [ ] 论文总结刷新后恢复（已有 Supabase 持久化）
- [ ] 检索词页面刷新后恢复（localStorage 7天）
- [ ] 概念探索器刷新后恢复（localStorage 7天）
- [ ] 多篇综述页面刷新后恢复（localStorage 7天）
- [ ] 论文转 PPT 刷新后恢复（localStorage 7天）

## 概念探索器

- [ ] 概念探索器最新进展有论文显示（输入任意概念，「最新进展」区块出现论文卡片）
- [ ] 中文概念可正常翻译为英文并搜索（查 pm2 日志确认 "翻译后英文" 不为空）

## 稳定性

- [ ] 所有 AI 接口的 `temperature` 参数已设置（结构化输出 0.3，对话 0.5）
- [ ] 论文总结 prompt 不限制字数，数据和细节完整保留
- [ ] PPT 生成使用 `claude-sonnet-4-5`（与其他路由一致）
- [ ] 翻译路由 `translate-page` 模型未被意外更改

## AppShell 路由规则（每次改 AppShell.tsx 必看）

- [ ] `ADMIN_PATHS = ["/admin"]` → 无 Shell，直接渲染
- [ ] `AUTH_PATHS = ["/login", "/auth", "/reset-password"]` → 无 Shell
- [ ] `BYPASS_PATHS = ["/paper/", "/search-history"]` → 有侧边栏，无 SPA tabs
- [ ] `/admin` 不在 `AUTH_PATHS` 里（历史 bug，已分离）
