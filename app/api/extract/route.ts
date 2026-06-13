// 后端接口：接收 PDF 文件，提取文字内容
// 路径：POST /api/extract

import { NextRequest, NextResponse } from "next/server";
import { extractTextFromPDF } from "@/lib/pdf";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "PDF 文件太大，最大支持 50MB" },
        { status: 413 }
      );
    }

    const file = formData.get("file") as File | null;

    // 检查是否有文件
    if (!file) {
      return NextResponse.json(
        { error: "请选择一个 PDF 文件" },
        { status: 400 }
      );
    }

    // 检查文件格式
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json(
        { error: "只支持 PDF 格式的文件" },
        { status: 400 }
      );
    }

    if (file.size > 50 * 1024 * 1024) {
      return NextResponse.json(
        { error: "PDF 文件太大（最大 50MB），请压缩后重试" },
        { status: 400 }
      );
    }

    // 提取文字
    const text = await extractTextFromPDF(file);

    return NextResponse.json({ text });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "解析失败，请重试";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
