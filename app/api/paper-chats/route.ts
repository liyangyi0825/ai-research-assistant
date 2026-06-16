// GET  /api/paper-chats?paperId=xxx  → { messages: [] }
// POST /api/paper-chats               → { paperId, messages } → upsert

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ messages: [] });

    const paperId = new URL(req.url).searchParams.get("paperId");
    if (!paperId) return NextResponse.json({ messages: [] });

    const { data } = await supabase
      .from("paper_chats")
      .select("messages")
      .eq("paper_id", paperId)
      .eq("user_id", user.id)
      .maybeSingle();

    return NextResponse.json({ messages: data?.messages ?? [] });
  } catch {
    return NextResponse.json({ messages: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { paperId, messages } = await req.json();
    if (!paperId || !Array.isArray(messages)) {
      return NextResponse.json({ error: "缺少参数" }, { status: 400 });
    }

    const { data: existing } = await supabase
      .from("paper_chats")
      .select("id")
      .eq("paper_id", paperId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("paper_chats")
        .update({ messages, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    } else {
      await supabase
        .from("paper_chats")
        .insert({ paper_id: paperId, user_id: user.id, messages });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}
