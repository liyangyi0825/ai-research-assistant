// 后端接口：基于论文内容进行对话（流式输出）
// 路径：POST /api/chat

import { NextRequest, NextResponse, after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "服务器未配置 API Key" },
        { status: 500 }
      );
    }

    // 用量限额检查（每月 30 次对话），同时取得 userId
    const { allowed, used, limit, userId } = await checkUsageLimit("chat");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月对话次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 }
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
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1500,
          stream: true,
          system: [
            {
              type: "text",
              text: `你是一个学术论文助手。用户上传了一篇论文，你的任务是根据论文内容回答用户的问题。
请用中文回答，回答要准确、简洁，并直接基于论文内容。如果论文中没有相关信息，请如实说明。
回答中如涉及数学公式，请用 LaTeX 格式输出：行内公式用 $...$，独立公式用 $$...$$。

以下是论文的完整内容：
---
${truncatedContent}
---`,
              cache_control: { type: "ephemeral" },
            },
          ],
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

    // ── 流式透传 + 提取 token 用量 ──────────────────────────────────
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();

    let inputTokens = 0, outputTokens = 0, cacheCreate = 0, cacheRead = 0;
    let sseBuffer = "";

    // after() 在响应流发完后执行，Vercel 保证它能跑完再关闭函数
    if (userId) {
      after(async () => {
        await insertUsageRecord({
          userId,
          actionType: "chat",
          tokensInput: inputTokens,
          tokensOutput: outputTokens,
          cacheCreationTokens: cacheCreate,
          cacheReadTokens: cacheRead,
        });
      });
    }

    void (async () => {
      const reader = anthropicRes.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          await writer.write(value);

          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === "message_start" && evt.message?.usage) {
                inputTokens = evt.message.usage.input_tokens ?? 0;
                cacheCreate = evt.message.usage.cache_creation_input_tokens ?? 0;
                cacheRead   = evt.message.usage.cache_read_input_tokens ?? 0;
              } else if (evt.type === "message_delta" && evt.usage) {
                outputTokens = evt.usage.output_tokens ?? 0;
              }
            } catch { /* 跳过无法解析的行 */ }
          }
        }
      } finally {
        writer.close().catch(() => {});
      }
    })();

    return new Response(readable, {
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
