// 解析 [[关键词]] 高亮标记，用于 pptxgenjs 和预览组件共享
export interface TextSegment {
  text: string;
  highlight: boolean;
}

export function parseHighlights(text: string): TextSegment[] {
  if (!text.includes("[[")) return [{ text, highlight: false }];
  return text
    .split(/\[\[(.+?)\]\]/g)
    .map((part, i) => ({ text: part, highlight: i % 2 === 1 }))
    .filter(s => s.text.length > 0);
}
