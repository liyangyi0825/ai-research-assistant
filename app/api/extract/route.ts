// 后端接口：接收 PDF 文件，提取文字内容
// 路径：POST /api/extract

import { NextRequest, NextResponse } from "next/server";
import { extractTextFromPDF } from "@/lib/pdf";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    // 用量检查（每月最多提取 10 次 PDF）
    const { allowed, used, limit, userId } = await checkUsageLimit("extract_refs");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月 PDF 上传次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 }
      );
    }

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

    // 记录用量（不影响主流程；PDF提取无 AI token，填0）
    if (userId) {
      insertUsageRecord({ userId, actionType: "extract_refs", tokensInput: 0, tokensOutput: 0 }).catch(() => {});
    }

    return NextResponse.json({ text });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "解析失败，请重试";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
