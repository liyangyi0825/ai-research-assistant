// 后端接口：接收论文文字，调用 Claude API 生成结构化总结（流式输出）
// 路径：POST /api/summarize
// ⚠️ API Key 在服务器端读取，绝不暴露给浏览器

import { NextRequest, NextResponse, after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord, getSupabaseAuthClient } from "@/lib/supabase";

const DB_SAVE_INTERVAL = 400; // 每累积 400 个字符写一次数据库

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "服务器未配置 API Key，请检查 .env.local 文件" },
        { status: 500 }
      );
    }

    // 用量限额检查
    const { allowed, used, limit, userId } = await checkUsageLimit("summarize");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月 AI 总结次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 }
      );
    }

    // 获取 Supabase 客户端（用于增量保存）
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();

    const { content, paperId } = await req.json() as { content: string; paperId?: string };

    if (!content || content.trim().length === 0) {
      return NextResponse.json({ error: "论文内容为空" }, { status: 400 });
    }

    const truncatedContent = content.slice(0, 80000);

    // 如果有 paperId，先在 DB 创建/重置总结记录（is_complete=false），
    // 这样刷新页面时就能看到"总结未完成"状态
    if (paperId && user) {
      const { data: existing } = await supabase
        .from("paper_summaries")
        .select("id")
        .eq("paper_id", paperId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (existing) {
        await supabase
          .from("paper_summaries")
          .update({ summary_content: "", is_complete: false, updated_at: new Date().toISOString() })
          .eq("id", existing.id);
      } else {
        await supabase
          .from("paper_summaries")
          .insert({ paper_id: paperId, user_id: user.id, summary_content: "", is_complete: false });
      }
    }

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
        max_tokens: 8000,
        temperature: 0.3,
        stream: true,
        messages: [
          {
            role: "user",
            content: `请仔细阅读以下学术论文，用中文生成一份结构化总结。

格式要求：
1. 严格按照【研究问题】【研究方法】【主要结论】【创新点】四个标题输出，不要添加其他内容
2. 使用 Markdown 格式标记重点：
   - 关键术语、核心发现、重要数字用 **加粗** 标出（每段最多 2-3 处，不要过度加粗）
   - 有多个并列要点时，用列表格式（每项以 - 开头）展示
   - 没有并列要点时，直接写段落即可
3. 内容详实，根据论文复杂程度自由决定每段长度，不人为限制字数，重要数据和细节要保留

输出格式示例：
【研究问题】
本文针对**某领域核心问题**展开研究，背景是...

【研究方法】
作者采用了**方法名称**，主要包括：
- 步骤或模块一
- 步骤或模块二

【主要结论】
实验结果表明**关键指标提升了 X%**，具体发现：
- 结论一
- 结论二

【创新点】
- 首次提出了**创新方法名**
- 在**特定场景**下取得了超越基线的效果

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

    // ── 流式透传 + 提取 token 用量 + 增量保存到 DB ──────────────────────
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let inputTokens = 0, outputTokens = 0, cacheCreate = 0, cacheRead = 0;
    let sseBuffer = "";
    let accumulatedText = "";   // 累积已生成的总结文字
    let lastDbSaveLen = 0;      // 上次写 DB 时的文字长度

    if (userId) {
      after(async () => {
        await insertUsageRecord({
          userId,
          actionType: "summarize",
          tokensInput: inputTokens,
          tokensOutput: outputTokens,
          cacheCreationTokens: cacheCreate,
          cacheReadTokens: cacheRead,
        });
      });
    }

    void (async () => {
      const reader = anthropicRes.body!.getReader();
      let lastHeartbeat = Date.now();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // 每 5 秒发一次心跳，防止 Nginx proxy_read_timeout 断开
          if (Date.now() - lastHeartbeat > 5000) {
            await writer.write(encoder.encode(": k\n\n"));
            lastHeartbeat = Date.now();
          }

          // 原样转发给前端
          await writer.write(value);

          // 解析 SSE：拿 token 数 + 提取生成文字
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
              } else if (
                evt.type === "content_block_delta" &&
                evt.delta?.type === "text_delta" &&
                typeof evt.delta.text === "string"
              ) {
                accumulatedText += evt.delta.text;
                // 每累积 DB_SAVE_INTERVAL 个字符写一次数据库（非阻塞）
                if (paperId && user && accumulatedText.length - lastDbSaveLen >= DB_SAVE_INTERVAL) {
                  lastDbSaveLen = accumulatedText.length;
                  void supabase.from("paper_summaries")
                    .update({ summary_content: accumulatedText })
                    .eq("paper_id", paperId)
                    .eq("user_id", user.id);
                }
              }
            } catch { /* 跳过无法解析的行 */ }
          }
        }

        // 流结束：保存完整总结并标记 is_complete=true
        if (paperId && user && accumulatedText) {
          await supabase.from("paper_summaries")
            .update({
              summary_content: accumulatedText,
              is_complete:     true,
              updated_at:      new Date().toISOString(),
            })
            .eq("paper_id", paperId)
            .eq("user_id", user.id);
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
    console.error("请求失败:", error);
    const msg = error instanceof Error ? error.message : "请求失败，请重试";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
