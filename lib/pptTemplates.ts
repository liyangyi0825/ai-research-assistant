// PPT 视觉模板配置：generate-file（PPTX导出）和 PptSlidePreview（网页预览）共用同一份颜色定义，
// 保证导出的 PPTX 和预览效果一致。所有颜色均不带 # 前缀（pptxgenjs 规定），
// 前端使用时通过 lib/pptTemplates 的 cssColor() 补上 #。

export type TemplateId = "academic_blue" | "minimal_white" | "tech_gradient";

export interface PptColorPalette {
  NAVY: string;      // 主色：标题栏/强调色块背景
  NAVY_D: string;     // 主色深色变体：封面/结尾页背景
  GOLD: string;       // 强调色：装饰线、金句高亮
  BG: string;         // 页面画布背景（内容页/目录/表格等）
  SOFT_BG: string;    // 浅色调面板背景（卡片底板、图表分析条、表格间隔行）
  LIGHT: string;      // hero/数据卡片页背景
  GRAY: string;       // 分隔线/边框
  TEXT: string;       // 正文文字颜色
  WHITE: string;      // 深色元素之上的文字/图标颜色（始终与深色背景形成对比）
  RED: string;
  ORANGE: string;
  GREEN: string;
  PURPLE: string;
  CARD_HEADS: [string, string, string]; // card 版式卡片标题栏渐变三色
}

export const PPT_TEMPLATES: Record<TemplateId, PptColorPalette> = {
  academic_blue: {
    NAVY: "1B3A8C", NAVY_D: "0F2361", GOLD: "C8A44A",
    BG: "FFFFFF", SOFT_BG: "EEF2FF", LIGHT: "F0F4FF", GRAY: "E0E4EE", TEXT: "1A1A2E", WHITE: "FFFFFF",
    RED: "8B1A1A", ORANGE: "B8600A", GREEN: "1B6B3A", PURPLE: "5B1A7A",
    CARD_HEADS: ["1B3A8C", "224A9A", "2D60B0"],
  },
  minimal_white: {
    NAVY: "2C3E50", NAVY_D: "1B2631", GOLD: "3498DB",
    BG: "FFFFFF", SOFT_BG: "F4F6F8", LIGHT: "FAFBFC", GRAY: "D5DBE0", TEXT: "2C3E50", WHITE: "FFFFFF",
    RED: "C0392B", ORANGE: "CA8A04", GREEN: "1E8449", PURPLE: "6C3483",
    CARD_HEADS: ["2C3E50", "34495E", "3498DB"],
  },
  tech_gradient: {
    NAVY: "0F2027", NAVY_D: "0A171C", GOLD: "2C5364",
    BG: "0F2027", SOFT_BG: "1C343D", LIGHT: "16282E", GRAY: "3A5A63", TEXT: "E8F1F2", WHITE: "FFFFFF",
    RED: "C0392B", ORANGE: "D68910", GREEN: "16A085", PURPLE: "7D3C98",
    CARD_HEADS: ["0F2027", "203A43", "2C5364"],
  },
};

export const DEFAULT_TEMPLATE: TemplateId = "academic_blue";

export const TEMPLATE_LIST: { id: TemplateId; name: string; desc: string }[] = [
  { id: "academic_blue", name: "学术蓝", desc: "深蓝底金色装饰，正式严谨" },
  { id: "minimal_white", name: "简约白", desc: "白底细灰线，克制干净" },
  { id: "tech_gradient",  name: "科技感", desc: "深色背景，现代科技风" },
];

export function resolveTemplate(templateId?: string | null): PptColorPalette {
  return PPT_TEMPLATES[(templateId as TemplateId) ?? DEFAULT_TEMPLATE] ?? PPT_TEMPLATES[DEFAULT_TEMPLATE];
}
