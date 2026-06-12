// 科研档案 AI 整理：把 5 个问答整理成结构化档案
// 路径：POST /api/profile/summarize

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { getSupabaseAuthClient } from "@/lib/supabase";

const QUESTIONS = [
  "你现在读几年级？主要做什么方向的研究？",
  "你最近在研究的具体课题是什么？或者说你的毕业论文/项目是做什么的？",
  "你平时怎么找论文和资料？比如先找综述、还是直接搜关键词、还是导师推荐？",
  "你现在研究里遇到最头疼的问题是什么？",
  "你已经比较熟悉哪些研究方法或技术？",
];

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });

    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { answers } = await req.json() as { answers: string[] };
    if (!answers?.length) return NextResponse.json({ error: "缺少回答内容" }, { status: 400 });

    const qa = QUESTIONS.slice(0, answers.length)
      .map((q, i) => `Q${i + 1}：${q}\nA${i + 1}：${answers[i] || "（未回答）"}`)
      .join("\n\n");

    const res = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 600,
        messages: [{
          role: "user",
          content: `根据以下学生的回答，整理出他的研究档案。只输出纯 JSON，不要代码块，不要任何解释。

${qa}

严格按此格式输出：
{"research_direction":"研究方向（1-2句，具体）","research_workflow":"科研流程（描述习惯步骤，2-4句）","core_question":"目前最想解决的核心问题（1句）","known_methods":"已熟悉的方法（关键词，逗号分隔）"}`,
        }],
      }),
    });

    if (!res.ok) return NextResponse.json({ error: "AI 整理失败" }, { status: 500 });

    const data = await res.json();
    const text: string = data.content?.[0]?.text ?? "";
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const profile = JSON.parse(cleaned);
    return NextResponse.json({ profile });
  } catch (err) {
    console.error("Profile summarize error:", err);
    return NextResponse.json({ error: "整理失败，请重试" }, { status: 500 });
  }
}
