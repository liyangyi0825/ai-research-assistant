// POST /api/context-chat
// 通用上下文对话接口（检索词页 / 概念探索页复用）
// 消耗 chat 配额，流式输出

import { NextRequest, NextResponse, after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
    if (!apiKey) {
      return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });
    }

    const { allowed, used, limit, userId } = await checkUsageLimit("chat");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月对话次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 },
      );
    }

    const { context, messages } = (await req.json()) as {
      context: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    };

    if (!context?.trim() || !messages?.length) {
      return NextResponse.json({ error: "缺少必要参数" }, { status: 400 });
    }

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 8000,
        temperature: 0.5,
        stream: true,
        system: context.slice(0, 40000),
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error(`context-chat Anthropic 错误 ${anthropicRes.status}:`, errBody);
      return NextResponse.json({ error: "AI 回复失败，请重试" }, { status: 500 });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let inputTokens = 0, outputTokens = 0, cacheCreate = 0, cacheRead = 0;
    let sseBuffer = "";

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
      const thinkingBlocks = new Set<number>();
      let lastHeartbeat = Date.now();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (Date.now() - lastHeartbeat > 5000) {
            await writer.write(encoder.encode(": k\n\n"));
            lastHeartbeat = Date.now();
          }
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) {
              await writer.write(encoder.encode(line + "\n"));
              continue;
            }
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") {
              await writer.write(encoder.encode(line + "\n"));
              continue;
            }
            try {
              const evt = JSON.parse(raw);
              if (evt.type === "content_block_start" && evt.content_block?.type === "thinking") {
                thinkingBlocks.add(evt.index ?? -1);
              }
              if (typeof evt.index === "number" && thinkingBlocks.has(evt.index)) continue;
              if (evt.type === "message_start" && evt.message?.usage) {
                inputTokens = evt.message.usage.input_tokens ?? 0;
                cacheCreate = evt.message.usage.cache_creation_input_tokens ?? 0;
                cacheRead   = evt.message.usage.cache_read_input_tokens ?? 0;
              } else if (evt.type === "message_delta" && evt.usage) {
                outputTokens = evt.usage.output_tokens ?? 0;
              }
              await writer.write(encoder.encode(line + "\n"));
            } catch { await writer.write(encoder.encode(line + "\n")); }
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
    console.error("context-chat 请求失败:", error);
    return NextResponse.json({ error: "请求失败，请稍后重试" }, { status: 500 });
  }
}
