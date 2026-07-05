// 论文记录 API：GET 列表 / POST 新建
// 路径：/api/my-papers
// 对应数据库字段：id, user_id, title, content, file_size, created_at

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAuthClient, getSupabaseAdminClient } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const limit    = searchParams.get("limit");
    const search   = searchParams.get("search") ?? "";
    const page     = parseInt(searchParams.get("page")     ?? "1",  10);
    const pageSize = parseInt(searchParams.get("pageSize") ?? "20", 10);

    // 列表不返回 content（内容可能很大），只返回元数据
    let query = supabase
      .from("papers")
      .select("id, title, file_size, created_at", { count: "exact" })
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (search) query = query.ilike("title", `%${search}%`);
    if (limit)  query = query.limit(parseInt(limit, 10));
    else        query = query.range((page - 1) * pageSize, page * pageSize - 1);

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

    const { title, content, fileSize } = await req.json();

    const { data, error } = await supabase
      .from("papers")
      .insert({
        user_id:   user.id,
        title:     ((title as string) || "未命名论文").slice(0, 300),
        // 最多存 200 000 字符，防止单条记录过大
        content:   content ? (content as string).slice(0, 200000) : null,
        file_size: (fileSize as number) ?? null,
      })
      .select("id")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ id: data.id });
  } catch {
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const admin = getSupabaseAdminClient();
    if (!admin) return NextResponse.json({ error: "服务器配置错误" }, { status: 500 });

    const { data: papers } = await admin
      .from("papers")
      .select("id")
      .eq("user_id", user.id);

    const ids = (papers ?? []).map((p) => p.id);

    if (ids.length > 0) {
      // 1. 删除 paper_summaries 里的缓存总结
      await admin.from("paper_summaries").delete().in("paper_id", ids);
      // 2. 删除来自这些论文的研究笔记（source_id 关联）
      await admin.from("research_notes").delete().eq("user_id", user.id).in("source_id", ids);
    }

    // 3. 删除所有论文本身
    const { error } = await admin.from("papers").delete().eq("user_id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "删除失败" }, { status: 500 });
  }
}
