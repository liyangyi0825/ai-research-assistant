// 后端接口：从论文内容生成 BibTeX 和 GB/T 7714 引用格式
// 路径：POST /api/cite

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { getSupabaseAuthClient } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });
    }

    // 验证用户已登录
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }

    const { content } = await req.json();
    if (!content) {
      return NextResponse.json({ error: "缺少论文内容" }, { status: 400 });
    }

    // 取前 6000 字符，标题/作者/期刊信息一般在开头
    const truncated = (content as string).slice(0, 6000);

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 800,
        messages: [
          {
            role: "user",
            content: `从以下论文内容提取文献信息，生成两种引用格式。只输出纯 JSON，不要代码块、不要任何解释。

输出格式：{"bibtex": "完整BibTeX条目", "gbt7714": "完整国标条目"}

规则：
- BibTeX：类型优先 @article，无期刊信息则用 @misc；key = 第一作者姓氏 + 年份（如 Zhang2023）；找不到的字段直接省略
- GB/T 7714-2015：格式为 作者. 题名[文献类型]. 出版信息, 年份, 卷(期): 页码. DOI（期刊文章用[J]，会议论文用[C]，找不到的字段直接省略）

论文内容：
---
${truncated}
---`,
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("Claude API 错误:", err);
      return NextResponse.json({ error: "引用生成失败" }, { status: 500 });
    }

    const data = await anthropicRes.json();
    const text: string = data.content?.[0]?.text ?? "";

    // 清除可能的 markdown 代码块再解析 JSON
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return NextResponse.json({
      bibtex: parsed.bibtex ?? "",
      gbt7714: parsed.gbt7714 ?? "",
    });
  } catch (error) {
    console.error("引用生成异常:", error);
    return NextResponse.json({ error: "引用生成失败，请重试" }, { status: 500 });
  }
}
