// 后端接口：接收 PDF 文件，提取文字内容
// 路径：POST /api/extract

import { NextRequest, NextResponse } from "next/server";
import { extractTextFromPDF } from "@/lib/pdf";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
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

    // 检查文件大小（最大 4MB，Vercel 免费版请求体上限为 4.5MB）
    if (file.size > 4 * 1024 * 1024) {
      return NextResponse.json(
        { error: "PDF 文件太大（最大 4MB），请压缩后重试" },
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
