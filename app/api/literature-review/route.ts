// POST /api/literature-review
// 多篇论文综述对比分析（流式输出）

import { NextRequest, NextResponse, after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });

    const { allowed, used, limit, userId } = await checkUsageLimit("literature_review");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月综述对比次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 },
      );
    }

    const { papers } = (await req.json()) as {
      papers: Array<{ name: string; content: string }>;
    };

    if (!papers?.length || papers.length < 2) {
      return NextResponse.json({ error: "至少需要 2 篇论文" }, { status: 400 });
    }

    const paperList = papers
      .map((p, i) => `=== 论文 ${i + 1}：${p.name} ===\n${p.content}`)
      .join("\n\n");

    const prompt = `你是一位专业的学术综述专家。用户上传了以下 ${papers.length} 篇论文，请进行系统性对比分析。

【论文内容】
${paperList}

【输出要求】
请严格按照以下 6 个模块依次输出，每个模块用 ## 标题开始，全部使用中文。

## 研究概览
生成一个 Markdown 表格，列为：论文、研究问题、研究方法、主要结论、创新点。每篇论文一行，内容精炼（每格不超过 30 字）。

## 研究脉络
分析这些论文在时间上的研究进展，谁的研究影响了谁，领域如何演进（250–350 字）。

## 方法对比
详细对比各论文使用的研究方法异同，分析各方法的优缺点（250–350 字）。

## 结论异同
总结各论文结论一致的地方，以及存在争议或矛盾的地方（250–350 字）。

## 研究空白
基于这些论文的覆盖范围，指出尚未解决的问题和可能的研究切入点（250–350 字）。

## 综述初稿
基于以上所有分析，生成一段 500–700 字的综述段落，学术风格，可直接用于论文综述章节写作。`;

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 6000,
        temperature: 0.3,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("literature-review Claude 错误:", err);
      return NextResponse.json({ error: "AI 分析失败，请重试" }, { status: 500 });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let inputTokens = 0, outputTokens = 0;
    let sseBuffer = "";

    if (userId) {
      after(async () => {
        await insertUsageRecord({
          userId,
          actionType: "literature_review",
          tokensInput: inputTokens,
          tokensOutput: outputTokens,
        });
      });
    }

    void (async () => {
      const reader = anthropicRes.body!.getReader();
      const thinkingBlocks = new Set<number>();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
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
    console.error("literature-review 请求失败:", error);
    return NextResponse.json({ error: "请求失败，请稍后重试" }, { status: 500 });
  }
}
