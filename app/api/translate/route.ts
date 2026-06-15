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

    const prompt = `你是专业的科技论文翻译专家。你的任务是将给定的 ${paragraphs.length} 个文本块逐一翻译成中文。

【核心要求——必须严格遵守】
- 输入有 ${paragraphs.length} 个文本块，你必须输出恰好 ${paragraphs.length} 个译文，一一对应，不得多也不得少
- 文本块之间用 [|||] 分隔，除此之外不要输出任何其他内容
- 禁止合并文本块、禁止拆分文本块、禁止跳过文本块
- 禁止输出原文、禁止解释、禁止加注释

翻译规范：
1. 章节标题保留原有编号，例如"1. Introduction"→"1. 引言"，"2.1 Methods"→"2.1 方法"
2. 专业术语格式：中文（English），例如"界面钝化（interface passivation）"
3. 人名、机构名、期刊名、数据集名称保留英文原文

输出格式示例（假设输入3块）：
第一块的中文译文[|||]第二块的中文译文[|||]第三块的中文译文

现在请翻译以下 ${paragraphs.length} 个文本块（文本块之间用 [PARA] 标记分隔）：

${paragraphs.join("\n[PARA]\n")}`;

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4000,
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
