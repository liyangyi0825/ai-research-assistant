// 论文相关类型定义

/** 论文信息 */
export interface Paper {
  id: string;
  title: string;
  content: string;       // 从 PDF 提取的原文文字
  createdAt: Date;
}

/** AI 生成的论文总结 */
export interface PaperSummary {
  researchQuestion: string;  // 研究问题
  methods: string;           // 研究方法
  conclusions: string;       // 主要结论
  innovations: string;       // 创新点
}

/** 对话消息 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
