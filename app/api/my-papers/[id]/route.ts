// 论文记录 API：GET 单篇（含全文内容）/ DELETE 删除
// 路径：/api/my-papers/[id]

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient, getSupabaseAdminClient } from "@/lib/supabase";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { data, error } = await supabase
      .from("papers")
      .select("id, title, content, file_size, created_at")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (error || !data) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    return NextResponse.json({ paper: data });
  } catch {
    return NextResponse.json({ error: "请求失败" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    // 验证论文归属，只能删除自己的论文
    const { data: paper } = await supabase
      .from("papers")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    if (!paper) return NextResponse.json({ error: "论文不存在或无权删除" }, { status: 404 });

    // 用 admin client 绕过 RLS 进行级联删除
    const admin = getSupabaseAdminClient();
    if (!admin) return NextResponse.json({ error: "服务器配置错误" }, { status: 500 });

    // 1. 删除 paper_summaries 里的缓存总结
    await admin.from("paper_summaries").delete().eq("paper_id", id);

    // 2. 删除来自这篇论文的研究笔记（source_id 关联）
    await admin.from("research_notes").delete()
      .eq("user_id", user.id)
      .eq("source_id", id);

    // 3. 删除论文本身
    const { error: delErr } = await admin
      .from("papers")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "删除失败" }, { status: 500 });
  }
}
