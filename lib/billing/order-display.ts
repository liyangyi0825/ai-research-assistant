import type { BillingOrderStatus } from "./repositories";

export const ORDER_STATUS_DISPLAY = {
  PENDING: { label: "待支付", tone: "attention" },
  PAID: { label: "已支付", tone: "success" },
  FAILED: { label: "支付失败", tone: "neutral" },
  CANCELLED: { label: "已取消", tone: "neutral" },
  CLOSED: { label: "已关闭", tone: "neutral" },
  REFUNDING: { label: "退款审核中", tone: "attention" },
  REFUNDED: { label: "已退款", tone: "neutral" },
} as const satisfies Record<BillingOrderStatus, { label: string; tone: string }>;

const FEATURE_LABELS: Record<string, string> = {
  deep_research: "深度研究",
  summarize: "论文总结",
  chat: "论文对话",
  translate: "全文翻译",
  ppt_generate: "生成演示文稿",
  concept_explore: "概念探索",
  keyword_gen: "关键词矩阵",
  bibtex_export: "参考文献导出",
  extract_refs: "参考文献提取",
  profile_summarize: "科研档案整理",
  literature_review: "多篇综述对比",
  latex_export: "LaTeX 导出",
  data_clean: "数据清洗",
  polish: "论文润色",
};

export function billingFeatureLabel(featureKey: string): string {
  return FEATURE_LABELS[featureKey] ?? featureKey;
}
