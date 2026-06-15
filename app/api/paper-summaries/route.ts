// 论文总结存储 API：GET 读取 / POST 保存
// 路径：/api/paper-summaries?paperId=xxx

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ summary: null });

    const paperId = new URL(req.url).searchParams.get("paperId");
    if (!paperId) return NextResponse.json({ summary: null });

    const { data } = await supabase
      .from("paper_summaries")
      .select("summary_content, created_at, updated_at")
      .eq("paper_id", paperId)
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json({ summary: data ?? null });
  } catch {
    return NextResponse.json({ summary: null });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { paperId, summaryContent } = await req.json();
    if (!paperId || !summaryContent) {
      return NextResponse.json({ error: "缺少参数" }, { status: 400 });
    }

    // 检查是否已有总结——有则更新，无则新建
    const { data: existing } = await supabase
      .from("paper_summaries")
      .select("id")
      .eq("paper_id", paperId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("paper_summaries")
        .update({
          summary_content: summaryContent,
          updated_at:      new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      await supabase
        .from("paper_summaries")
        .insert({
          paper_id:        paperId,
          user_id:         user.id,
          summary_content: summaryContent,
        });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}
