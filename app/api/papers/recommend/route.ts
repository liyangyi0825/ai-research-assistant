// POST /api/papers/recommend
// 输入：{ papers: AnalyzedPaper[], topic: string }
// 输出：SSE 流。第一行是 LABELS JSON，后续是推荐分析文本
// 不单独消耗配额（与 AI 精准搜索共享一次 keyword_gen）

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { getSupabaseAuthClient } from "@/lib/supabase";
import type { AnalyzedPaper } from "@/app/api/papers/search/route";

export async function POST(req: NextRequest) {
  try {
    const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
    if (!apiKey) return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });

    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const { papers, topic } = (await req.json()) as { papers: AnalyzedPaper[]; topic: string };
    if (!papers?.length) return NextResponse.json({ error: "无论文数据" }, { status: 400 });

    const papersText = papers
      .map((p, i) =>
        `[${i + 1}] 标题："${p.titleCn || p.title}"\n摘要：${(p.abstract || "无摘要").slice(0, 200)}`
      )
      .join("\n\n");

    const prompt = `用户研究课题：「${topic}」

以下是搜索到的 ${papers.length} 篇论文（标号 1-${papers.length}）：

${papersText}

请将论文按阅读价值分为四个等级。

**第一行必须且只能是以下格式的单行 JSON（不换行，不加代码块，不加注释）：**
LABELS:{"top":[强推论文的编号],"recommend":[次推荐编号],"reference":[可参考编号],"skip":[可跳过编号]}

要求：
- "top" 一般 1-2 篇（与课题最直接相关，值得精读）
- "recommend" 一般 2-3 篇（有重要参考价值）
- "reference" 一般 2-4 篇（有一定关联，浏览摘要即可）
- "skip" 其余篇（与课题关联度较低）
- 每篇论文必须且只能出现在一个类别，不能遗漏任何一篇
- 如某类别为空，写 []

从第二行开始输出推荐分析（用中文，700 字以内）：

根据你的课题「${topic}」，我推荐优先读这几篇：

⭐ 最推荐：[论文中文标题]
理由：[为何与课题高度相关，值得精读，可提及具体方法/发现]

✅ 次推荐：[论文中文标题（如多篇，分别列出）]
理由：[具体理由]

📌 可以参考：[标题（如多篇，可合并说明）]
理由：[整体说明]

⏭️ 可以暂时跳过：其余 X 篇
理由：[简要说明为何关联度较低]`;

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
        temperature: 0.3,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("Claude 推荐分析错误:", err);
      return NextResponse.json({ error: "AI 分析失败，请重试" }, { status: 500 });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let sseBuffer = "";

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
    console.error("推荐分析异常:", error);
    return NextResponse.json({ error: "请求失败，请重试" }, { status: 500 });
  }
}
