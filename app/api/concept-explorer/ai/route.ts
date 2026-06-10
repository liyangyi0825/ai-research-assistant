// 后端接口：概念探索器的 Claude 流式 AI（区块 1/3/4）
// 路径：POST /api/concept-explorer/ai

import { NextRequest, NextResponse, after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";
import type { Paper } from "../papers/route";

function buildPrompt(
  block: number,
  concept: string,
  papers: Paper[],
  originText: string,
  conceptsText: string,
): string {
  if (block === 1) {
    return `你是一位学术专家，请用中文回答关于学术概念「${concept}」的以下问题：

## 学术定义
用 2-3 句话给出准确的学术定义。

## 起源背景
最早由谁在什么背景下提出？大约什么年代？解决了什么核心问题？

## AI 估计的源头论文
给出 1-2 篇你认为最可能是该概念起源的论文（包含第一作者、期刊/会议名称、大约年份）。
在这部分末尾加上：> ⚠️ AI 估计，仅供参考，请以数据库查询结果为准

请用 Markdown 格式输出，语言简洁专业。`;
  }

  if (block === 3) {
    const abstracts = papers
      .map((p, i) =>
        `**第${i + 1}篇**：${p.title}（${p.year}）\n摘要：${(p.abstract ?? "无摘要").slice(0, 300)}`
      )
      .join("\n\n");

    return `以下是关于「${concept}」的 ${papers.length} 篇近期高引论文：

${abstracts}

请从以上摘要中提取 8-12 个反复出现或密切相关的方法/术语/概念：
- 格式：**中文术语（English Term）**——出现在第 X、X 篇论文中
- 按出现频率从高到低排列
- 只列清单，不要其他解释`;
  }

  if (block === 4) {
    const paperList = papers
      .map((p, i) => `第${i + 1}篇：${p.title}（${p.year}，引用 ${p.citationCount} 次）`)
      .join("\n");

    return `研究概念：「${concept}」

近期高引论文：
${paperList}

关联概念（提取自摘要）：
${conceptsText || "（暂无）"}

概念起源摘要：
${originText.slice(0, 500) || "（暂无）"}

请基于以上信息，用中文输出：

## 知识连接
一段话（100 字以内）描述上述概念之间的关系脉络。

## 研究思路建议

**建议 1**
如果将[概念A]和[概念B]结合，目前文献中尚未有人系统研究[具体方向]，这可能是一个值得探索的切入点。

**建议 2**
（同上格式，另一个方向）

**建议 3**
（同上格式，另一个方向）

---
> ⚠️ 以上为 AI 建议，请结合导师意见和领域实际情况判断`;
  }

  return "";
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });
    }

    // 用量检查（消耗 chat 配额，仅在 block=1 时检查并记录，避免重复扣除）
    const { allowed, used, limit, userId } = await checkUsageLimit("chat");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月对话次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 }
      );
    }

    const { concept, block, papers = [], originText = "", conceptsText = "" } = await req.json();

    if (!concept?.trim() || ![1, 3, 4].includes(block)) {
      return NextResponse.json({ error: "参数错误" }, { status: 400 });
    }

    const prompt = buildPrompt(block, concept.trim(), papers, originText, conceptsText);

    const maxTokens = block === 1 ? 700 : block === 3 ? 900 : 900;

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: maxTokens,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("Claude API 错误:", err);
      return NextResponse.json({ error: "AI 分析失败，请重试" }, { status: 500 });
    }

    // 流式透传，同时提取 token 用量
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();

    let inputTokens = 0, outputTokens = 0, cacheCreate = 0, cacheRead = 0;
    let sseBuffer = "";

    // block=1 时记录用量（整个探索流程只记录一次）
    if (block === 1 && userId) {
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
            } catch { /* 跳过 */ }
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
    console.error("概念探索 AI 异常:", error);
    return NextResponse.json({ error: "请求失败，请重试" }, { status: 500 });
  }
}
