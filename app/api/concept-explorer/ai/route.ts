// 后端接口：概念探索器的 Claude 流式 AI（区块 1/3/4）
// 路径：POST /api/concept-explorer/ai

import { NextRequest, NextResponse, after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord, insertSearchHistory } from "@/lib/supabase";
import type { Paper } from "../papers/route";

function buildPrompt(
  block: number,
  concept: string,
  papers: Paper[],
  originText: string,
  conceptsText: string,
): string {
  if (block === 1) {
    const paperSection = papers.length > 0
      ? `\n\n## 早期相关论文\n以下是从学术数据库真实检索到的、按发表年份从早到晚排列的相关论文，请只依据这些真实数据来分析：\n${papers
          .map((p, i) =>
            `**第${i + 1}篇**：${p.title}（${p.year ?? "年份未知"}）\n作者：${p.authors}${p.abstract ? `\n摘要：${p.abstract.slice(0, 200)}` : ""}`
          )
          .join("\n\n")}\n\n用一句话说明这些论文与该概念起源的关系（是否可能就是源头论文，还是仅为相关早期工作）。**禁止编造这份列表之外的任何论文标题、作者或年份。**`
      : `\n\n## 早期相关论文\n数据库未检索到明确的早期论文。请如实说明"暂未查到数据库中的早期论文"，**不要编造任何论文标题、作者或年份**，可建议用户自行在知网 / Google Scholar 查证。`;

    return `你是一位学术专家，请用中文回答关于学术概念「${concept}」的以下问题：

## 学术定义
用 2-3 句话给出准确的学术定义。

## 起源背景
最早由谁在什么背景下提出？大约什么年代？解决了什么核心问题？如果无法确定具体人物或年份，可概述该领域的发展脉络，不要编造具体人名、年份或论文。
${paperSection}

请用 Markdown 格式输出，语言简洁专业。`;
  }

  if (block === 3) {
    const abbreviationGuide = `
【缩写识别规则——最高优先级】
- 用户输入如果是全大写字母组合（如 CDPR、CNN、LSTM、GAN），必须先判断这是一个专业领域缩写
- 必须在学术文献中找到该缩写最常见的全称，例如 CDPR = Cable-Driven Parallel Robot（绳索驱动并联机器人）
- 所有展开的关联概念必须与该缩写的真实含义强相关，不得基于字母本身随意联想
- 如果一个缩写有多个领域的含义，优先选择工程/自然科学领域的解释，并在第一个概念中注明全称
- 输出的第一个概念必须是该缩写的全称解释，格式为："XX（全称，缩写）——[定义]"
  例如："绳索驱动并联机器人（Cable-Driven Parallel Robot，CDPR）——通过多根独立控制的柔索替代刚性连杆..."`;

    const conceptQualityGuide = `
提取质量要求：
- 只提取以下类型的专业概念：专业技术名词（如：缆索驱动并联机器人、运动解耦、逆运动学）、具体方法名称（如：RecurDyn仿真、多体动力学建模）、领域特定概念（如：冗余驱动、工作空间分析）、有学术引用价值的术语
- 禁止提取以下通用词：技术、方法、系统、设计、分析、研究、应用、结果、数据、模型——这些词太宽泛，没有学术价值
- 提取 8-12 个高质量专业概念，宁缺毋滥
- 每个概念附上一句话的学术定义，说明它在该领域中的具体含义
- 格式：**中文术语（English Term）**——学术定义（一句话）`;

    // 没有论文时改用"AI 知识库模式"，直接基于训练知识生成关联概念
    if (papers.length === 0) {
      return `请根据你的学术知识，列出与「${concept}」密切相关的专业学术概念：
${abbreviationGuide}
${conceptQualityGuide}
- 按相关程度从高到低排列
- 只输出列表，不要其他说明

最后加一行：
> ⚠️ 未找到数据库论文，以上内容来自 AI 知识库，仅供参考`;
    }

    const abstracts = papers
      .map((p, i) =>
        `**第${i + 1}篇**：${p.title}（${p.year}）\n摘要：${(p.abstract ?? "无摘要").slice(0, 300)}`
      )
      .join("\n\n");

    return `以下是关于「${concept}」的 ${papers.length} 篇近期高引论文：

${abstracts}

请从以上摘要中提取反复出现或密切相关的专业学术概念：
${abbreviationGuide}
${conceptQualityGuide}
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
    const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
    if (!apiKey) {
      return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });
    }

    // 用量检查（消耗 concept_explore 配额，仅在 block=1 时检查并记录，避免重复扣除）
    const { allowed, used, limit, userId } = await checkUsageLimit("concept_explore");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月概念探索器次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 }
      );
    }

    const { concept, block, papers = [], originText = "", conceptsText = "" } = await req.json();

    if (!concept?.trim() || ![1, 3, 4].includes(block)) {
      return NextResponse.json({ error: "参数错误" }, { status: 400 });
    }

    const prompt = buildPrompt(block, concept.trim(), papers, originText, conceptsText);

    const maxTokens = 8000;

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: maxTokens,
        temperature: 0.1,
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

    // block=1 时记录用量 + 保存搜索历史（整个探索流程只记录一次）
    if (block === 1 && userId) {
      insertSearchHistory({ userId, type: "concept_explore", query: concept.trim() });
      after(async () => {
        await insertUsageRecord({
          userId,
          actionType: "concept_explore",
          tokensInput: inputTokens,
          tokensOutput: outputTokens,
          cacheCreationTokens: cacheCreate,
          cacheReadTokens: cacheRead,
        });
      });
    }

    void (async () => {
      const reader = anthropicRes.body!.getReader();
      const enc = new TextEncoder();
      const thinkingBlocks = new Set<number>();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";

          for (const line of lines) {
            // 非 data 行（空行等）保持原样转发，维持 SSE 格式
            if (!line.startsWith("data: ")) {
              await writer.write(enc.encode(line + "\n"));
              continue;
            }
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") {
              await writer.write(enc.encode(line + "\n"));
              continue;
            }
            try {
              const evt = JSON.parse(raw);
              // 记录 thinking 块的 index，后续跳过属于它的所有事件
              if (evt.type === "content_block_start" && evt.content_block?.type === "thinking") {
                thinkingBlocks.add(evt.index ?? -1);
              }
              // 跳过 thinking 块的所有事件
              if (typeof evt.index === "number" && thinkingBlocks.has(evt.index)) continue;

              // 提取 token 用量
              if (evt.type === "message_start" && evt.message?.usage) {
                inputTokens = evt.message.usage.input_tokens ?? 0;
                cacheCreate = evt.message.usage.cache_creation_input_tokens ?? 0;
                cacheRead   = evt.message.usage.cache_read_input_tokens ?? 0;
              } else if (evt.type === "message_delta" && evt.usage) {
                outputTokens = evt.usage.output_tokens ?? 0;
              }

              // 转发非 thinking 事件
              await writer.write(enc.encode(line + "\n"));
            } catch {
              await writer.write(enc.encode(line + "\n"));
            }
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
