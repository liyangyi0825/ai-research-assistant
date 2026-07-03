// 后端接口：接收论文文字，调用 Claude API 生成结构化总结（流式输出）
// 路径：POST /api/summarize
// ⚠️ API Key 在服务器端读取，绝不暴露给浏览器

import { NextRequest, NextResponse, after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord, getSupabaseAuthClient } from "@/lib/supabase";

const DB_SAVE_INTERVAL = 400; // 每累积 400 个字符写一次数据库

export async function POST(req: NextRequest) {
  try {
    const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
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
        model: "deepseek-v4-pro",
        max_tokens: 16000,
        temperature: 0.1,
        stream: true,
        messages: [
          {
            role: "user",
            content: `请仔细阅读以下学术论文，用中文生成一份结构化总结。

格式要求：
1. 严格按照【研究问题】【研究方法】【主要结论】【创新点】四个标题输出，不要添加其他内容
2. 使用 Markdown 格式标记重点：
   - 关键术语、核心数据、重要结论用 **加粗** 标出（每段最多 2-3 处，不要过度加粗）
   - 有多个并列要点时，用列表格式（每项以 - 开头）展示
   - 没有并列要点时，直接写段落即可
3. 内容详实，根据论文复杂程度自由决定每段长度，重要数据和细节必须保留

⚠️ 数据提取要求（最重要，每条结论必须有数据支撑）：
主动从论文中提取并引用以下内容：
- 实验数值：精度、误差、速度、效率等具体数字（如"旋转精度 ±0.02°"、"响应时间 12ms"）
- 对比数据：与现有方法相比提升了多少（如"比传统方法效率提升 34%"、"工作空间扩大 2.3 倍"）
- 实验条件：样本量、测试环境、验证方式（如"在 500 次实验中"、"经 RMSE 验证"）
- 关键参数：论文中出现的具体设计数字（如"质量 6.74kg、半径 250mm"）
- 图表来源：结论来自某图或某表时，标注"（见 Fig.X）"或"（Table X）"

⛔ 禁止出现：
- 无数据支撑的模糊结论：如"效果较好"、"性能有所提升"、"明显改善"
- 纯定性描述（结论后没有跟具体数值）
- 直接照搬摘要原文

输出格式示例：
【研究问题】
本文针对**某领域核心问题**展开研究。现有方法在某指标上误差达 X°，无法满足精度要求（<0.5°），因此提出了...

【研究方法】
作者采用了**方法名称**（质量 6.74kg，半径 250mm），主要包括：
- 步骤一：具体做法 + 关键参数
- 步骤二：具体做法 + 实验条件（如"在 500N 负载下测试"）

【主要结论】
- 旋转精度提升至 **±0.02°** 以内，优于现有最优方法的 ±0.08°（提升 75%，Table 3）
- 工作空间扩大了 **2.3 倍**（与传统并联机构相比，Fig.5 对比实验）

【创新点】
- 首次提出了**创新方法名**，使某指标从 X 提升至 Y（提升幅度 Z%）
- 在**特定场景**下，以 Xms 响应时间实现了超越基线的效果

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
      const thinkingBlocks = new Set<number>();
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

          // 解析 SSE：拿 token 数 + 提取生成文字 + 过滤 thinking 块
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
              await writer.write(encoder.encode(line + "\n"));
            } catch { await writer.write(encoder.encode(line + "\n")); }
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
