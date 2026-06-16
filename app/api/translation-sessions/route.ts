// GET  /api/translation-sessions?sessionId=xxx  → { session: {...} | null }
// POST /api/translation-sessions                 → { fileName, pages } → { id }

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ session: null });

    const sessionId = new URL(req.url).searchParams.get("sessionId");
    if (!sessionId) return NextResponse.json({ session: null });

    const { data } = await supabase
      .from("translation_sessions")
      .select("id, file_name, page_count, pages, created_at")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();

    return NextResponse.json({ session: data ?? null });
  } catch {
    return NextResponse.json({ session: null });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { fileName, pages } = await req.json() as {
      fileName: string;
      pages: { text: string; translation: string }[];
    };
    if (!fileName || !Array.isArray(pages)) {
      return NextResponse.json({ error: "缺少参数" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("translation_sessions")
      .insert({
        user_id: user.id,
        file_name: fileName,
        page_count: pages.length,
        pages,
      })
      .select("id")
      .single();

    if (error) throw error;

    return NextResponse.json({ id: data.id });
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}
