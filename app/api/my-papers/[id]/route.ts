// 论文记录 API：GET 单篇 / PATCH 更新已用功能
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
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (error || !data) return NextResponse.json({ error: "论文不存在" }, { status: 404 });
    return NextResponse.json({ paper: data });
  } catch {
    return NextResponse.json({ error: "请求失败" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { feature } = await req.json();
    if (!feature) return NextResponse.json({ error: "缺少 feature 参数" }, { status: 400 });

    // 读取当前 features_used，避免重复写入
    const { data: current } = await supabase
      .from("papers")
      .select("features_used")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    const existing: string[] = current?.features_used ?? [];
    if (existing.includes(feature)) {
      return NextResponse.json({ ok: true }); // 已记录，幂等返回
    }

    const { error } = await supabase
      .from("papers")
      .update({
        features_used: [...existing, feature],
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "更新失败" }, { status: 500 });
  }
}
