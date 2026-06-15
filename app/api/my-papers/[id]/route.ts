// 论文记录 API：GET 单篇（含全文内容）
// 路径：/api/my-papers/[id]

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient } from "@/lib/supabase";

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
