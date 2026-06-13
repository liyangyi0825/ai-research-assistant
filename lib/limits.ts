// 月度使用限制配置
// 免费用户每月可使用 AI 功能的次数限制

export const FREE_MONTHLY_LIMITS = {
  summarize: 5,           // 论文总结每月5次
  chat: 30,               // 对话每月30次
  keyword_gen: 20,        // 关键词矩阵每月20次
  bibtex_export: 30,      // BibTeX导出每月30次
  concept_explore: 10,    // 概念探索器每月10次（最贵，限制严格些）
  profile_summarize: 5,   // 科研档案AI整理每月5次
} as const;

export type UsageActionType = keyof typeof FREE_MONTHLY_LIMITS;