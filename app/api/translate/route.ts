// 后端接口：接收论文段落列表，调用 Claude API 流式翻译
// 路径：POST /api/translate
// 输入：{ paragraphs: string[] }  ← 已在客户端拆好的段落数组
// 输出：SSE 流，翻译文字中用 [|||] 分隔每个段落的译文

import { NextRequest, NextResponse, after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });
    }

    const { allowed, used, limit, userId } = await checkUsageLimit("translate");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月全文翻译次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 },
      );
    }

    const { paragraphs } = (await req.json()) as { paragraphs: string[] };
    if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
      return NextResponse.json({ error: "段落内容为空" }, { status: 400 });
    }

    // 最多翻译 80 段，避免超 token 限制
    const limited = paragraphs.slice(0, 80);

    const prompt = `你是专业的科技论文翻译专家，请将以下英文论文段落逐段翻译成中文。

翻译规则：
1. 严格按照原文段落顺序逐段翻译，不得合并段落、不得拆分段落
2. 章节标题保留原有编号，例如"1. Introduction"译为"1. 引言"，"2.1 Methods"译为"2.1 方法"
3. 专业术语用"中文（English）"格式，例如"界面钝化（interface passivation）"
4. 人名、机构名、期刊名、数据集名称保留英文原文
5. 每段译文之间用 [|||] 分隔，数量必须与原文段落数完全一致（共 ${limited.length} 段就输出 ${limited.length} 段译文）
6. 只输出译文，不要解释，不要重复原文

需要翻译的段落（共 ${limited.length} 段，段落之间用 [PARA] 分隔）：

${limited.join("\n[PARA]\n")}`;

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 8000,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      return NextResponse.json({ error: `API 错误 ${anthropicRes.status}: ${errBody}` }, { status: 500 });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();

    let inputTokens = 0, outputTokens = 0, cacheCreate = 0, cacheRead = 0;
    let sseBuffer = "";

    if (userId) {
      after(async () => {
        await insertUsageRecord({
          userId,
          actionType: "translate",
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
            } catch { /* skip */ }
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
    const msg = error instanceof Error ? error.message : "请求失败，请重试";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
