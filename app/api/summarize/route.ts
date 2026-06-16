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

格式要求（最重要）：
- 严格按照【研究问题】【研究方法】【主要结论】【创新点】四个模块输出，每个模块用对应标题标注
- 四个模块之外不要添加任何引言、过渡语或总结段落
- 每个模块 2-4 句话，语言简洁准确，直接基于论文内容，不要推测或补充论文没有的内容
- 关键术语、方法名、核心数字用 **加粗** 标出（每段 2-3 处）
- 有多个并列要点时用列表（- 开头），单一内容直接写段落

内容要求：
- 每个部分必须提取论文中的**具体信息**：真实的方法名称、数据集名称、实验指标、百分比数字、对比基线等
- 不要写空洞的描述（如"作者提出了一种新方法"），要写出方法的具体名字和做法
- 如果论文有实验数据，必须在【主要结论】中列出关键数字
- 数学公式用简单 LaTeX 格式：行内公式用 $...$，独立公式用 $$...$$
- 禁止使用 \\begin{align}、\\begin{cases}、\\begin{equation} 等复杂环境，改用文字描述或简单的单行公式

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
