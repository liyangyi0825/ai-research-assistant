// POST /api/ppt/generate-section
// 输入：{ paperContent, outlineSlides, allOutline, scene, templateId?, userNotes? }
// 输出：{ slides: Slide[] } —— 只生成这一批（3-4页）幻灯片的完整正文内容
// 分批生成的目的：避免一次性生成全部页面导致 AI 输出被截断、结构混乱
import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";
import type { PptScene, Slide } from "@/app/api/ppt/generate-content/route";
import type { SlideOutlineItem } from "@/app/api/ppt/generate-outline/route";

/** 补全被截断的 JSON（括号计数法） */
function closeTruncatedJSON(raw: string): string {
  let inString = false, escape = false;
  let braces = 0, brackets = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") braces++;
    else if (c === "}") braces--;
    else if (c === "[") brackets++;
    else if (c === "]") brackets--;
  }
  let result = inString ? raw + '"' : raw;
  for (let i = 0; i < brackets; i++) result += "]";
  for (let i = 0; i < braces; i++) result += "}";
  return result;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });

    const {
      paperContent, outlineSlides, allOutline, scene, userNotes, batchIndex,
    } = (await req.json()) as {
      paperContent: string;
      outlineSlides: SlideOutlineItem[];
      allOutline: SlideOutlineItem[];
      scene: PptScene;
      templateId?: string;
      userNotes?: string;
      batchIndex?: number;
    };

    if (!paperContent?.trim()) return NextResponse.json({ error: "论文内容不能为空" }, { status: 400 });
    if (!Array.isArray(outlineSlides) || outlineSlides.length === 0) {
      return NextResponse.json({ error: "本批大纲为空" }, { status: 400 });
    }
    if (!["defense", "meeting"].includes(scene)) return NextResponse.json({ error: "场景参数错误" }, { status: 400 });

    // 只在第一批时检查/计入本月用量，避免分批调用被误计为多次生成
    let userId: string | null = null;
    if (!batchIndex || batchIndex === 0) {
      const usage = await checkUsageLimit("ppt_generate");
      if (!usage.allowed) {
        return NextResponse.json(
          { error: `本月生成 PPT 次数已用完（${usage.used}/${usage.limit} 次），下月 1 日自动重置` },
          { status: 429 },
        );
      }
      userId = usage.userId;
    }

    const isDefense = scene === "defense";
    const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" });
    const paperExcerpt = paperContent.slice(0, 25000);

    const prompt = `你是一位专业的学术PPT设计专家。请只为下面指定的这一批幻灯片骨架生成完整正文内容，输出 JSON 数组，以 [ 开头以 ] 结尾，不要代码块标记，不要任何说明文字。

【场景】${isDefense ? "毕业/学位答辩（正式学术风格）" : "组会/进展汇报（简洁风格）"}

【本批要生成的幻灯片骨架——⛔ 不得增减页面，不得改变 type，不得改变 title 的含义】
${JSON.stringify(outlineSlides, null, 2)}

【完整大纲（仅供理解上下文位置和前后逻辑，不要生成这里面的其它页）】
${JSON.stringify(allOutline, null, 2)}

${userNotes ? `【用户对本批页面的备注要求——必须按此调整内容侧重】\n${userNotes}\n` : ""}

【内容来源要求——最高优先级】
- 内容必须直接来自下面的论文原文，⛔ 不要脱离论文自己编造数据、结论或术语
- paragraphs/figure_desc/analysis 等文字优先摘录论文原句，保留原文数值和专业术语
- ⛔ 禁止使用"本研究表明""结果显示""可以看出"等二次总结语气开头，直接呈现论文原文的表述

【各类型字段要求】
- cover：title（沿用骨架标题）, subtitle, author（从论文提取作者/导师，格式"汇报人：xxx\\n指导教师：xxx"，找不到留空字符串）, date："${today}"
- contents：items（字符串数组，取完整大纲中各 section 类型页面的标题作为目录条目）
- section：number（沿用骨架 sectionNumber）, title（沿用骨架标题）
- content：layout（"standard"|"split"|"hero"|"card" 四选一，背景/综述用standard，研究发现用split，全文最核心单一结论用hero且最多用2次，2-3个并列子主题用card），title，paragraphs（standard/split需2段，每段80-150字；hero为[核心结论,补充说明]各1段；card时留空[]并填cards数组），cards（仅card版式需要，2-3项，每项{heading,points(2-4条，≤25字/条)}），flow（card版式，有先后顺序则true），notes（≤20字，口语说明承上启下）
  - 段落中用[[双方括号]]标记最关键1-2个词/数值，每段最多2处；⛔禁止bullet符号"•"出现在paragraphs里
- figure：title（沿用），figure_desc（摘录论文原文对该图的描述，不少于60字），analysis（摘录论文原文对该图的分析结论，不少于60字），notes（≤20字），chart_data（能从论文提取到具体数值序列时填写{chart_type:"line"|"bar",categories,series:[{name,values}],y_label}，提取不到就不要给这个字段，不要编造数字）
- stats：title，stats（3-4项{value,unit,label,color(可选，不带#)}）
- table：title，headers（列标题），rows（数据行，每行长度=headers长度）
- comparison：title，columns（2-3项{heading,color(不带#),points(3-5条)}）
- ending：无需额外字段

【格式禁忌】
- ⛔ 所有字符串字段内绝对不能出现英文直引号 " 或反斜杠 \\，需要引用/强调术语时改用「」，否则会破坏 JSON 格式

【输出】
只输出一个 JSON 数组，数组长度必须等于本批骨架页数，且顺序、type 与骨架一一对应。

【论文原文】
${paperExcerpt}`;

    const res = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 8000,
        temperature: 0.1,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `AI 生成失败（${res.status}）：${err.slice(0, 120)}` }, { status: 500 });
    }

    // 流式读取 SSE，拼接完整文本后再解析（非流式调用在 DeepSeek 兼容接口上偶发返回空内容）
    let rawText = "";
    let sseBuffer = "";
    let inputTokens = 0, outputTokens = 0;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            rawText += evt.delta.text ?? "";
          } else if (evt.type === "message_start" && evt.message?.usage) {
            inputTokens = evt.message.usage.input_tokens ?? 0;
          } else if (evt.type === "message_delta" && evt.usage) {
            outputTokens = evt.usage.output_tokens ?? 0;
          }
        } catch { /* 跳过无法解析的行 */ }
      }
    }

    const stripped = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const jsonStart = stripped.indexOf("[");
    const jsonEnd = stripped.lastIndexOf("]");
    const cleaned = jsonStart !== -1 && jsonEnd > jsonStart
      ? stripped.slice(jsonStart, jsonEnd + 1)
      : stripped;

    let slides: Slide[];
    try {
      slides = JSON.parse(cleaned);
    } catch {
      console.error("分批生成 JSON 首次解析失败，输出前500字：", rawText.slice(0, 500));
      console.error("分批生成 JSON 首次解析失败，输出末尾500字：", rawText.slice(-500));
      try {
        slides = JSON.parse(closeTruncatedJSON(cleaned));
        console.log("分批生成 JSON 截断补全成功");
      } catch (e2) {
        console.error("分批生成 JSON 截断补全仍失败：", e2 instanceof Error ? e2.message : String(e2));
        return NextResponse.json({ error: "AI 输出格式异常，请重试" }, { status: 500 });
      }
    }

    if (!Array.isArray(slides) || slides.length === 0) {
      return NextResponse.json({ error: "AI 输出内容为空，请重试" }, { status: 500 });
    }

    if (userId) {
      insertUsageRecord({
        userId, actionType: "ppt_generate",
        tokensInput: inputTokens, tokensOutput: outputTokens,
      }).catch(() => {});
    }

    return NextResponse.json({ slides });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `请求失败：${msg.slice(0, 120)}` }, { status: 500 });
  }
}
