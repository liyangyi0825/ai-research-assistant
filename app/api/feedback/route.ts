// 后端接口：接收用户反馈，存入 Supabase feedback 表
// 路径：POST /api/feedback

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Supabase 未配置，请联系管理员" },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const message = formData.get("message") as string;
    const email = (formData.get("email") as string | null) || null;
    const screenshot = formData.get("screenshot") as File | null;
    const pageUrl = (formData.get("pageUrl") as string | null) || null;

    if (!message?.trim()) {
      return NextResponse.json({ error: "反馈内容不能为空" }, { status: 400 });
    }

    let screenshotUrl: string | null = null;

    // 如果有截图，先上传到 Supabase Storage
    if (screenshot && screenshot.size > 0) {
      // 限制截图大小：最大 5MB
      if (screenshot.size > 5 * 1024 * 1024) {
        return NextResponse.json({ error: "截图不能超过 5MB" }, { status: 400 });
      }

      const ext = screenshot.name.split(".").pop()?.toLowerCase() || "png";
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const bytes = await screenshot.arrayBuffer();

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("feedback-screenshots")
        .upload(fileName, bytes, {
          contentType: screenshot.type || "image/png",
          upsert: false,
        });

      if (uploadError) {
        // 截图上传失败不影响反馈提交，记录日志即可
        console.error("截图上传失败:", uploadError.message);
      } else {
        const { data: urlData } = supabase.storage
          .from("feedback-screenshots")
          .getPublicUrl(uploadData.path);
        screenshotUrl = urlData.publicUrl;
      }
    }

    // 写入 feedback 表
    const { error: insertError } = await supabase.from("feedback").insert({
      message: message.trim(),
      email: email?.trim() || null,
      screenshot_url: screenshotUrl,
      page_url: pageUrl,
      user_agent: req.headers.get("user-agent") || null,
    });

    if (insertError) {
      console.error("写入反馈失败:", insertError.message);
      return NextResponse.json({ error: "保存失败，请重试" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("反馈接口出错:", error);
    const msg = error instanceof Error ? error.message : "提交失败，请重试";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
