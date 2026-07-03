// POST /api/polish
// 论文润色（流式输出）

import { NextRequest, NextResponse, after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

type Language = "zh" | "en";
type Discipline = "general" | "science" | "social_science" | "humanities" | "medical" | "business";
type Intensity = "light" | "medium" | "deep";

const LANGUAGE_PROMPTS: Record<Language, string> = {
  zh: "中文：优化为符合中文学术论文规范的表达，使用正式学术用语",
  en: "English：优化为符合英文学术期刊标准的表达，确保语法正确、用词精准",
};

const DISCIPLINE_PROMPTS: Record<Discipline, string> = {
  general: "通用：使用通用学术表达规范",
  science: "理工科：注重精确性、客观性，多用被动语态，避免主观描述",
  social_science: "社科：注重论证严密性，逻辑连接词的恰当使用",
  humanities: "人文：注重表达的丰富性和论述的深度",
  medical: "医学：遵循医学论文写作规范（IMRAD结构），术语使用精确",
  business: "商科经管：注重数据驱动的表述，管理学术语规范",
};

const INTENSITY_PROMPTS: Record<Intensity, string> = {
  light: "轻度：仅修正明显的语法错误、错别字、标点问题，不改变句式",
  medium: "中度：在轻度基础上，优化句式结构、改善段落衔接、提升表达的学术性",
  deep: "深度：在中度基础上，全面优化语言表达、重组不通顺的句子、增强逻辑连贯性、提升整体可读性",
};

function buildSystemPrompt(language: Language, discipline: Discipline, intensity: Intensity) {
  return `你是一位资深的学术论文润色专家。你的任务是提升论文的写作质量，包括语言表达、句式结构、学术规范和逻辑连贯性。

基本原则：
- 保持原文的核心观点和论证逻辑不变
- 不添加原文没有的观点或数据
- 不改变原文的学术立场
- 保留专业术语和专有名词
- 保留所有引用标注（如 [1]、(Smith, 2020) 等）

语言规范：${LANGUAGE_PROMPTS[language]}

学科规范：${DISCIPLINE_PROMPTS[discipline]}

润色强度：${INTENSITY_PROMPTS[intensity]}

请直接输出润色后的完整文本，不要输出解释、说明或修改标注。只返回润色后的正文内容。`;
}

const MAX_CHARS = 15000;

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });

    const { allowed, used, limit, userId } = await checkUsageLimit("polish");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月论文润色次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 },
      );
    }

    const body = (await req.json()) as {
      text?: string;
      language?: Language;
      discipline?: Discipline;
      intensity?: Intensity;
    };
    const text = (body.text ?? "").trim();
    const language = body.language === "en" ? "en" : "zh";
    const discipline: Discipline =
      body.discipline && body.discipline in DISCIPLINE_PROMPTS ? body.discipline : "general";
    const intensity: Intensity =
      body.intensity && body.intensity in INTENSITY_PROMPTS ? body.intensity : "medium";

    if (!text) return NextResponse.json({ error: "论文内容不能为空" }, { status: 400 });
    if (text.length > MAX_CHARS) {
      return NextResponse.json({ error: `内容超过${MAX_CHARS}字限制，请分段润色` }, { status: 400 });
    }

    const systemPrompt = buildSystemPrompt(language, discipline, intensity);

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 8192,
        temperature: 0.1,
        stream: true,
        system: systemPrompt,
        messages: [{ role: "user", content: `请润色以下论文内容：\n\n${text}` }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("polish Claude 错误:", err);
      return NextResponse.json({ error: "AI 润色失败，请重试" }, { status: 500 });
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
          actionType: "polish",
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
    console.error("polish 请求失败:", error);
    return NextResponse.json({ error: "请求失败，请稍后重试" }, { status: 500 });
  }
}
