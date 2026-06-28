// GET  /api/ppt/sessions?pptId=xxx  → { ppt: { id, file_name, scene, ppt_data, created_at } | null }
// POST /api/ppt/sessions             → { id }（新建或 upsert 同名文件的 PPT 记录）

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient, getSupabaseAdminClient } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ppt: null });

    const pptId = new URL(req.url).searchParams.get("pptId");
    if (!pptId) return NextResponse.json({ ppt: null });

    const { data } = await supabase
      .from("paper_ppts")
      .select("id, file_name, scene, ppt_data, created_at")
      .eq("id", pptId)
      .eq("user_id", user.id)
      .maybeSingle();

    return NextResponse.json({ ppt: data ?? null });
  } catch {
    return NextResponse.json({ ppt: null });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const body = await req.json() as {
      fileName: string;
      scene: string;
      pptData: unknown;
    };
    if (!body.fileName || !body.scene || !body.pptData) {
      return NextResponse.json({ error: "参数不完整" }, { status: 400 });
    }

    // Admin client 写入，绕过 RLS
    const admin = getSupabaseAdminClient();
    if (!admin) return NextResponse.json({ error: "服务器配置错误" }, { status: 500 });

    const { data, error } = await admin
      .from("paper_ppts")
      .insert({
        user_id:   user.id,
        file_name: body.fileName,
        scene:     body.scene,
        ppt_data:  body.pptData,
      })
      .select("id")
      .single();

    if (error) throw error;
    return NextResponse.json({ id: data.id });
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}
