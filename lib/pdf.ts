// PDF 解析工具封装
// 使用 unpdf 库从 PDF 文件中提取纯文本

import { extractText } from "unpdf";

/**
 * 从 PDF 文件中提取纯文本（合并为一个字符串）
 */
export async function extractTextFromPDF(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);

  const { text } = await extractText(buffer, { mergePages: true });

  if (!text || text.trim().length === 0) {
    throw new Error("无法从该 PDF 中提取文字，可能是扫描件或图片 PDF");
  }

  return text;
}

/**
 * 从 PDF 文件中按页提取文字，返回每页文字的数组
 * 用于全文翻译功能（替代浏览器端 pdfjs-dist 的 getTextContent）
 */
export async function extractPagesFromPDF(file: File): Promise<string[]> {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);
  const { text } = await extractText(buffer); // mergePages 默认 false，返回 string[]
  return text;
}
