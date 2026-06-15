// 论文记录 API：GET 列表 / POST 新建
// 路径：/api/my-papers

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const limit     = searchParams.get("limit");
    const search    = searchParams.get("search") ?? "";
    const page      = parseInt(searchParams.get("page") ?? "1", 10);
    const pageSize  = parseInt(searchParams.get("pageSize") ?? "20", 10);

    let query = supabase
      .from("papers")
      .select("id, title, file_name, char_count, features_used, created_at", { count: "exact" })
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (search) {
      query = query.ilike("title", `%${search}%`);
    }

    if (limit) {
      query = query.limit(parseInt(limit, 10));
    } else {
      query = query.range((page - 1) * pageSize, page * pageSize - 1);
    }

    const { data, error, count } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ papers: data ?? [], total: count ?? 0 });
  } catch {
    return NextResponse.json({ error: "请求失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { title, fileName, extractedText, charCount, featuresUsed } = await req.json();

    const { data, error } = await supabase
      .from("papers")
      .insert({
        user_id:       user.id,
        title:         (title || fileName || "未命名论文").slice(0, 300),
        file_name:     fileName || null,
        // 最多存 100,000 字符，防止单条记录过大
        extracted_text: extractedText ? extractedText.slice(0, 100000) : null,
        char_count:    charCount ?? extractedText?.length ?? 0,
        features_used: Array.isArray(featuresUsed) ? featuresUsed : [],
      })
      .select("id")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ id: data.id });
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}
