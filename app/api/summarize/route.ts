// 后端接口：接收论文文字，调用 Claude API 生成结构化总结（流式输出）
// 路径：POST /api/summarize
// ⚠️ API Key 在服务器端读取，绝不暴露给浏览器

import { NextRequest, NextResponse, after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "服务器未配置 API Key，请检查 .env.local 文件" },
        { status: 500 }
      );
    }

    // 用量限额检查（每月 5 次总结），同时取得 userId 供后续写入
    const { allowed, used, limit, userId } = await checkUsageLimit("summarize");
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
        max_tokens: 8000,
        stream: true,
        messages: [
          {
            role: "user",
            content: `请仔细阅读以下学术论文，用中文生成一份结构化总结。

内容要求（最重要）：
- 每个部分必须提取论文中的**具体信息**：真实的方法名称、数据集名称、实验指标、百分比数字、对比基线等
- 不要写空洞的描述（如"作者提出了一种新方法"），要写出方法的具体名字和做法
- 如果论文有实验数据，必须在【主要结论】中列出关键数字
- 数学公式用简单 LaTeX 格式：行内公式用 $...$，独立公式用 $$...$$
- 禁止使用 \begin{align}、\begin{cases}、\begin{equation} 等复杂环境，改用文字描述或简单的单行公式

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

    // ── 流式透传 + 提取 token 用量 ──────────────────────────────────
    // TransformStream 把 Anthropic SSE 流原封不动转发给前端，
    // 同时解析 message_start / message_delta 事件拿到真实 token 数，
    // 流结束后写入 usage 表。
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let inputTokens = 0, outputTokens = 0, cacheCreate = 0, cacheRead = 0;
    let sseBuffer = "";

    // after() 在响应流发完后执行，Vercel 保证它能跑完再关闭函数
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

          // 每5秒发一次心跳，防止 Nginx proxy_read_timeout 断开
          if (Date.now() - lastHeartbeat > 5000) {
            await writer.write(encoder.encode(": k\n\n"));
            lastHeartbeat = Date.now();
          }

          // 原样转发给前端
          await writer.write(value);

          // 解析 token 信息
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
    console.error("请求失败:", error);
    const msg = error instanceof Error ? error.message : "请求失败，请重试";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
