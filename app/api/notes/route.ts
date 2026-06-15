// 笔记 API：GET 列表 / POST 新建
// 路径：/api/notes

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient } from "@/lib/supabase";

export async function GET() {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { data, error } = await supabase
      .from("research_notes")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ notes: data ?? [] });
  } catch {
    return NextResponse.json({ error: "请求失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { concept, origin_summary, latest_papers, related_concepts, research_ideas, source_type, source_id, source_title } =
      await req.json();

    if (!concept?.trim()) {
      return NextResponse.json({ error: "缺少概念名称" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("research_notes")
      .insert({
        user_id:          user.id,
        concept:          concept.trim(),
        origin_summary:   origin_summary   || null,
        latest_papers:    latest_papers    || null,
        related_concepts: related_concepts || null,
        research_ideas:   research_ideas   || null,
        source_type:      source_type      || null,
        source_id:        source_id        || null,
        source_title:     source_title     || null,
      })
      .select("id")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ id: data.id });
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}
