// 按页提取 PDF 文字，供全文翻译功能使用
// 在服务器端用 unpdf 提取，比浏览器端 pdfjs-dist 兼容性更好

import { NextRequest, NextResponse } from "next/server";
import { extractPagesFromPDF } from "@/lib/pdf";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "未提供文件" }, { status: 400 });
    }

    if (file.size > 50 * 1024 * 1024) {
      return NextResponse.json({ error: "文件过大（最大 50MB）" }, { status: 413 });
    }

    const pages = await extractPagesFromPDF(file);
    return NextResponse.json({ pages });
  } catch (error) {
    const message = error instanceof Error ? error.message : "提取失败，请重试";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
