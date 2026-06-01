// 后端接口：基于论文内容进行对话（流式输出）
// 路径：POST /api/chat

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { recordUsage } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "服务器未配置 API Key" },
        { status: 500 }
      );
    }

    const { paperContent, messages } = await req.json();

    if (!paperContent || !messages?.length) {
      return NextResponse.json({ error: "缺少必要参数" }, { status: 400 });
    }

    const truncatedContent = paperContent.slice(0, 60000);

    const anthropicRes = await fetchWithProxy(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1500,
          stream: true,
          system: `你是一个学术论文助手。用户上传了一篇论文，你的任务是根据论文内容回答用户的问题。
请用中文回答，回答要准确、简洁，并直接基于论文内容。如果论文中没有相关信息，请如实说明。

以下是论文的完整内容：
---
${truncatedContent}
---`,
          messages: messages,
        }),
      }
    );

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error(`Anthropic API 错误 ${anthropicRes.status}:`, errBody);
      return NextResponse.json(
        { error: "AI 回复失败，请重试" },
        { status: 500 }
      );
    }

    // 记录用量（不影响主流程）
    await recordUsage("chat");

    // 直接把 Anthropic 的 SSE 流透传给前端
    return new Response(anthropicRes.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("对话请求失败:", error);
    return NextResponse.json(
      { error: "请求失败，请稍后重试" },
      { status: 500 }
    );
  }
}
