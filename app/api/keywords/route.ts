// 后端接口：根据研究课题生成精准英文检索词组合
// 路径：POST /api/keywords

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { getSupabaseAuthClient } from "@/lib/supabase";

export interface KeywordCombination {
  keywords: string;
  description: string;
}

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

    const { topic } = await req.json();
    if (!topic || !topic.trim()) {
      return NextResponse.json({ error: "请输入研究课题" }, { status: 400 });
    }

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1200,
        messages: [
          {
            role: "user",
            content: `你是学术检索专家。用户的研究课题是：「${topic.trim()}」

请生成 8-10 个精准的英文 Google Scholar 检索词组合，全面覆盖这个课题的各个方向。

要求：
- 每个组合包含 2-4 个关键词，用 AND 连接（如 "deep learning AND medical image segmentation"）
- 覆盖不同角度：① 核心方法 ② 具体应用/任务 ③ 对比基线或前人工作 ④ 数据集/评测（如适用）
- 使用学术圈真实使用的英文专业术语，避免过于宽泛
- description 字段：用一句话的中文说明该组合的检索目标

只输出纯 JSON，不要代码块，不要任何解释：
{"combinations":[{"keywords":"term1 AND term2","description":"中文说明"}]}`,
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("Claude API 错误:", err);
      return NextResponse.json({ error: "关键词生成失败" }, { status: 500 });
    }

    const data = await anthropicRes.json();
    const text: string = data.content?.[0]?.text ?? "";

    // 清除可能的 markdown 代码块
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return NextResponse.json({
      combinations: parsed.combinations as KeywordCombination[],
    });
  } catch (error) {
    console.error("关键词生成异常:", error);
    return NextResponse.json({ error: "生成失败，请重试" }, { status: 500 });
  }
}
