// 科研档案 API：GET 读取 / POST 保存（upsert）/ DELETE 清空
// 路径：/api/profile

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient } from "@/lib/supabase";

export async function GET() {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ profile: null }, { status: 401 });

    const { data } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    return NextResponse.json({ profile: data ?? null });
  } catch {
    return NextResponse.json({ profile: null }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const {
      research_direction,
      research_workflow,
      core_question,
      known_methods,
      ai_preferences = [],
      profile_complete = false,
    } = await req.json();

    const { data, error } = await supabase
      .from("user_profiles")
      .upsert(
        {
          user_id:            user.id,
          research_direction: research_direction ?? null,
          research_workflow:  research_workflow  ?? null,
          core_question:      core_question      ?? null,
          known_methods:      known_methods      ?? null,
          ai_preferences:     ai_preferences,
          profile_complete,
        },
        { onConflict: "user_id" }
      )
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ profile: data });
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { error } = await supabase
      .from("user_profiles")
      .delete()
      .eq("user_id", user.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "删除失败" }, { status: 500 });
  }
}
