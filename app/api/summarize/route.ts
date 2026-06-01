// 后端接口：接收论文文字，调用 Claude API 生成结构化总结（流式输出）
// 路径：POST /api/summarize
// ⚠️ API Key 在服务器端读取，绝不暴露给浏览器

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { recordUsage, checkUsageLimit } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "服务器未配置 API Key，请检查 .env.local 文件" },
        { status: 500 }
      );
    }

    // 用量限额检查（每月 5 次总结）
    const { allowed, used, limit } = await checkUsageLimit("summarize");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月 AI 总结次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 }
      );
    }

    const { content } = await req.json();

    if (!content || content.trim().length === 0) {
      return NextResponse.json({ error: "论文内容为空" }, { status: 400 });
    }

    const truncatedContent = content.slice(0, 80000);

    // 调用 Anthropic API，开启 stream: true
    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2000,
        stream: true,
        messages: [
          {
            role: "user",
            content: `请仔细阅读以下学术论文，用中文生成一份结构化总结。

内容要求（最重要）：
- 每个部分必须提取论文中的**具体信息**：真实的方法名称、数据集名称、实验指标、百分比数字、对比基线等
- 不要写空洞的描述（如"作者提出了一种新方法"），要写出方法的具体名字和做法
- 如果论文有实验数据，必须在【主要结论】中列出关键数字

格式要求：
- 严格按照【研究问题】【研究方法】【主要结论】【创新点】四个标题输出
- 关键术语、方法名、核心数字用 **加粗** 标出（每段 2-3 处）
- 有多个并列要点时用列表（- 开头），单一内容直接写段落

论文内容如下：
---
${truncatedContent}
---`,
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error(`Anthropic API 错误 ${anthropicRes.status}:`, errBody);
      return NextResponse.json(
        { error: `API错误 ${anthropicRes.status}: ${errBody}` },
        { status: 500 }
      );
    }

    // 记录用量（不影响主流程）
    await recordUsage("summarize");

    // 直接把 Anthropic 的 SSE 流透传给前端
    return new Response(anthropicRes.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no", // 禁止 nginx/Vercel 缓冲，确保实时推送
      },
    });
  } catch (error) {
    console.error("请求失败:", error);
    const msg = error instanceof Error ? error.message : "请求失败，请重试";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
