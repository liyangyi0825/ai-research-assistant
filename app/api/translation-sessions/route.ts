// GET  /api/translation-sessions?sessionId=xxx  → { session: {...} | null }
// POST /api/translation-sessions
//   无 sessionId → 创建新会话（空 pages，is_complete=false）→ { id }
//   有 sessionId → 更新 pages / is_complete

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
      .select("id, file_name, page_count, pages, is_complete, created_at")
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

    const body = await req.json() as {
      fileName?: string;
      pages?: { text: string; translation: string }[];
      sessionId?: string;
      isComplete?: boolean;
    };

    if (body.sessionId) {
      // ── 更新已有会话 ──────────────────────────────────────────────────
      const updates: Record<string, unknown> = {};
      if (body.pages !== undefined) {
        updates.pages      = body.pages;
        updates.page_count = body.pages.length;
      }
      if (body.isComplete !== undefined) {
        updates.is_complete = body.isComplete;
      }

      if (Object.keys(updates).length > 0) {
        await supabase
          .from("translation_sessions")
          .update(updates)
          .eq("id", body.sessionId)
          .eq("user_id", user.id);
      }
      return NextResponse.json({ id: body.sessionId });
    } else {
      // ── 创建新会话（初始为空）──────────────────────────────────────────
      if (!body.fileName) {
        return NextResponse.json({ error: "缺少文件名" }, { status: 400 });
      }
      const { data, error } = await supabase
        .from("translation_sessions")
        .insert({
          user_id:    user.id,
          file_name:  body.fileName,
          page_count: 0,
          pages:      [],
          is_complete: false,
        })
        .select("id")
        .single();

      if (error) throw error;
      return NextResponse.json({ id: data.id });
    }
  } catch {
    return NextResponse.json({ error: "操作失败" }, { status: 500 });
  }
}
