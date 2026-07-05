// GET  /api/search-history  —— 获取当前用户的搜索历史（最近 100 条）
// DELETE /api/search-history  —— 删除一条历史记录

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient } from "@/lib/supabase";

export async function GET() {
  const supabase = await getSupabaseAuthClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { data, error } = await supabase
    .from("search_history")
    .select("id, type, query, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ history: data ?? [] });
}

export async function DELETE(req: NextRequest) {
  const { id, all } = await req.json();
  const supabase = await getSupabaseAuthClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  if (!all && !id) return NextResponse.json({ error: "缺少参数" }, { status: 400 });

  let query = supabase.from("search_history").delete().eq("user_id", user.id);
  if (!all) query = query.eq("id", id);

  const { error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
