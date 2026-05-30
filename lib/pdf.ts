// PDF 解析工具封装
// 使用 unpdf 库从 PDF 文件中提取纯文本

import { extractText } from "unpdf";

/**
 * 从 PDF 文件中提取纯文本内容
 * @param file 用户上传的 PDF 文件
 * @returns 提取出的文字字符串
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
