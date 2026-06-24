// 月度使用限制配置
// 免费用户每月可使用 AI 功能的次数限制

export const FREE_MONTHLY_LIMITS = {
  summarize: 5,           // 论文总结每月5次
  chat: 30,               // 对话每月30次
  translate: 3,           // 全文翻译每月3次（成本较高）
  ppt_generate: 3,        // 生成PPT每月3次
  concept_explore: 10,    // 概念探索器每月10次
  keyword_gen: 20,        // 关键词矩阵每月20次
  bibtex_export: 30,      // BibTeX导出每月30次
  extract_refs: 10,       // PDF文件提取每月10次
  profile_summarize: 5,   // 科研档案AI整理每月5次
  literature_review: 3,   // 多篇综述对比每月3次
  latex_export: 5,        // LaTeX 导出每月5次
  data_clean: 10,         // 数据清洗每月10次
} as const;

export type UsageActionType = keyof typeof FREE_MONTHLY_LIMITS;