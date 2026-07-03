// POST /api/ppt/generate-content
// 输入：{ paperContent: string, scene: "defense" | "meeting" }
// 输出：{ pptContent: PptContent } 结构化 JSON，供前端预览和后续生成 PPTX 文件使用

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

export type PptScene = "defense" | "meeting";

// ── 基础布局 ──────────────────────────────────────────────────────────────────
export interface CoverSlide {
  type: "cover";
  title: string;
  subtitle: string;
  author: string;   // 支持 \n 换行（如 "汇报人：xxx\n指导教师：xxx"）
  date: string;
}

export interface ContentsSlide {
  type: "contents";
  items: string[];
}

export interface SectionSlide {
  type: "section";
  number: string;   // "01" "02" …
  title: string;
}

export interface ContentSlide {
  type: "content";
  layout?: "standard" | "split" | "hero" | "card";
  title: string;
  paragraphs: string[]; // standard/split: 完整要点列表；hero: [核心数据陈述, 补充说明(可选)]；card: 留空数组 []
  cards?: Array<{ heading: string; points: string[]; imageHint?: string }>; // card 版式专用：2-3 个并列主题卡片；imageHint 存在时在卡片下半生成图片占位框
  flow?: boolean; // card 版式专用：true = 卡片间有先后顺序，渲染时画流程箭头
  notes: string;
}

export interface FigureSlide {
  type: "figure";
  title: string;
  figure_desc: string;  // 图表展示内容（含具体数值）
  analysis: string;     // 从图表得出的结论（含具体数值和意义）
  notes: string;
}

export interface EndingSlide {
  type: "ending";
}

// ── 富内容布局（新增）────────────────────────────────────────────────────────

/** 大数字数据卡片：展示 3-4 个关键数值（如容量、效率、粒径） */
export interface StatsSlide {
  type: "stats";
  title: string;
  stats: Array<{
    value: string;  // 核心数值，如 "4200"、"300%"、"2630"
    unit: string;   // 单位，如 "mAh/g"、"体积膨胀"、"m²/g"
    label: string;  // 简短说明，如 "硅理论比容量"、"体积膨胀率"
    color?: string; // 可选卡片颜色，如 "1B3A8C"（不带#）
  }>;
  notes: string;
}

/** 数据表格：展示实验参数、性能对比等表格数据 */
export interface TableSlide {
  type: "table";
  title: string;
  headers: string[];    // 列标题
  rows: string[][];     // 数据行，每行与 headers 列数相同
  notes: string;
}

/** 并排对比：2-3 列对比分析（如不同样品/方法的优缺点对比） */
export interface ComparisonSlide {
  type: "comparison";
  title: string;
  columns: Array<{
    heading: string;    // 列标题，如 "低浓度样品"
    color: string;      // 列主色（不带#），如 "1B3A8C"
    points: string[];   // 该列要点，3-5 条
  }>;
  notes: string;
}

export type Slide =
  | CoverSlide
  | ContentsSlide
  | SectionSlide
  | ContentSlide
  | EndingSlide
  | StatsSlide
  | TableSlide
  | ComparisonSlide
  | FigureSlide;

export interface PptContent {
  title: string;
  scene: string;
  total_pages: number;
  slides: Slide[];
}

/**
 * 补全被截断的 JSON 字符串（括号计数法）。
 * 能处理截断发生在字符串内部的情况（如 "paragrap 被截断）。
 */
function closeTruncatedJSON(raw: string): string {
  let inString = false, escape = false;
  let braces = 0, brackets = 0;
  let lastValidPos = -1; // 最后一个完整 JSON value 结束位置

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") braces++;
    else if (c === "}") { braces--; if (braces === 0) lastValidPos = i; }
    else if (c === "[") brackets++;
    else if (c === "]") brackets--;
  }

  // 如果截断在字符串内：先关闭字符串，再补括号
  let result = inString ? raw + '"' : raw;
  // 补 ] 再补 }（顺序：先内层数组，再外层对象）
  for (let i = 0; i < brackets; i++) result += "]";
  for (let i = 0; i < braces; i++) result += "}";
  return result;
}

/** 解析 AI 输出的 JSON 对象，带截断容错 */
function parseRawJSON<T>(rawText: string): T {
  const stripped = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  // 如果 AI 漏掉最外层 {，自动补上
  const fixedJson = stripped.trimStart().startsWith("{")
    ? stripped
    : '{"slides": ' + stripped + "}";
  const s = fixedJson.indexOf("{");
  if (s === -1) throw new Error("JSON 对象解析失败：找不到 {");
  const base = fixedJson.slice(s);

  // 1. 直接解析
  const e = base.lastIndexOf("}");
  if (e > 0) {
    try { return JSON.parse(base.slice(0, e + 1)) as T; } catch {}
  }
  // 2. 括号计数法补全后解析
  try { return JSON.parse(closeTruncatedJSON(base)) as T; } catch {}
  // 3. 找最后一个完整对象（找最后的 "},"）
  const lastComma = base.lastIndexOf("},");
  if (lastComma > 0) {
    try { return JSON.parse(base.slice(0, lastComma + 1) + "]}") as T; } catch {}
  }
  throw new Error("JSON 对象解析失败");
}


export async function POST(req: NextRequest) {
  try {
    const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
    if (!apiKey) return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });

    const { allowed, used, limit, userId } = await checkUsageLimit("ppt_generate");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月生成 PPT 次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 },
      );
    }

    const { paperContent, scene } = (await req.json()) as {
      paperContent: string;
      scene: PptScene;
    };

    if (!paperContent?.trim()) return NextResponse.json({ error: "论文内容不能为空" }, { status: 400 });
    if (!["defense", "meeting"].includes(scene)) return NextResponse.json({ error: "场景参数错误" }, { status: 400 });

    const extractKeyContent = (content: string): string => {
      const abstractMatch   = content.match(/abstract[\s\S]{0,3000}/i);
      const methodsMatch    = content.match(/methods?[\s\S]{0,3000}/i);
      const resultsMatch    = content.match(/results?[\s\S]{0,4000}/i);
      const conclusionMatch = content.match(/conclusion[\s\S]{0,3000}/i);
      const figureMatches   = content.match(/(?:figure|table|图|表)\s*\d+[\s\S]{0,300}/gi)
        ?.slice(0, 10).join("\n") ?? "";

      const combined = [
        abstractMatch?.[0]   ?? "",
        methodsMatch?.[0]    ?? "",
        resultsMatch?.[0]    ?? "",
        conclusionMatch?.[0] ?? "",
        figureMatches,
      ].filter(Boolean).join("\n\n---\n\n");

      if (combined.length < 2000) return content.slice(0, 30000);
      return combined.slice(0, 30000);
    };

    const keyContent = extractKeyContent(paperContent);

    const isDefense = scene === "defense";
    const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" });

    const prompt = `【输出要求——最高优先级】
输出必须是完整的合法 JSON，以 { 开头，以 } 结尾。
如果内容太多导致无法在 token 限制内完成，优先保证 JSON 结构完整，可以减少幻灯片总页数，但每页内容必须完整，不要截断输出。
只输出纯 JSON，不要代码块标记，不要任何说明文字。

【任务】将以下论文内容转化为高质量的PPT结构化大纲。

【场景】${isDefense ? "毕业/学位答辩（正式学术风格）" : "组会/进展汇报（简洁风格）"}

【一致性要求——违反视为严重错误】
- 必须按照论文的实际章节结构生成，章节标题直接从论文提取原文，不得自行概括或改写
- 严格按照论文从头到尾的顺序生成，不得跳过任何章节
- 每次生成同一篇论文，章节结构和页面顺序必须保持一致

【页数与字数限制——必须严格遵守，这是控制输出长度的关键】
- slides 数组总页数：不超过 13 页（这是硬性上限，避免输出被截断）
- 每个 paragraphs 段落：50-120 字（约 2-3 句话），⛔ 禁止空数组 [] 或空字符串
- notes 字段：不超过 20 字
- figure_desc 字段：不超过 60 字
- analysis 字段：不超过 60 字
- card.points 每条：不超过 25 字
- ⛔ type=content 的 standard/split/hero 页面，paragraphs 至少要有 1 个非空段落
${isDefense
  ? "- 结构：封面→目录→章节过渡页→内容页→结尾页"
  : "- 结构：封面→目录→内容页→结尾页（省略章节过渡页）"
}

【layout 选择（每个 content 页必须判断，⛔ 禁止全部 standard）】
- layout 只有 4 种合法值："standard" | "split" | "hero" | "card"，⛔ 不要用 "figure"（那是 type 字段，不是 layout）
- hero：全文最关键单一数据/结论，最多 2 页
- split：研究发现/实验结论，至少 2 页
- card：内容分 2-3 个并列子主题时用，需有 cards 数组，paragraphs 填 []
- standard：研究背景/文献综述/叙述性内容
- 图表类内容用 type="figure"（独立类型，不是 content+layout=figure）

【paragraphs 格式】
- standard/split：1-2 个段落，每段不超过 80 字，流畅陈述性文字，含数值+因果
- hero：paragraphs[0] 为核心结论（20-40字含数值），paragraphs[1] 可选补充说明
- 段落里用 [[双方括号]] 标记最关键 1-2 个词/数值，每段最多 2 处
- ⛔ 禁止 bullet point（"•"）出现在 paragraphs 里

【cover 字段提取规则】
- 从论文正文提取作者和导师，找不到留空字符串 ""，不要写"XXX"等占位符
- author 格式："汇报人：[姓名]\\n指导教师：[导师姓名职称]"

【JSON 格式示例】
{"title":"论文标题","scene":"${scene}","total_pages":N,"slides":[
  {"type":"cover","title":"...","subtitle":"...","author":"汇报人：xxx\\n指导教师：xxx","date":"${today}"},
  {"type":"contents","items":["一、研究背景","二、研究方法","三、实验结果","四、结论"]},
  {"type":"section","number":"01","title":"研究背景"},
  {"type":"content","layout":"standard","title":"研究背景","paragraphs":["硅基负极材料理论比容量高达[[4200 mAh/g]]，是石墨的11倍，但体积膨胀达300%导致循环性能差。"],"notes":"引出研究动机"},
  {"type":"content","layout":"hero","title":"核心发现","paragraphs":["低固含量样品500次循环后容量保持率高达[[89%]]。","对比高固含量样品仅61%，差距显著，证明固含量是关键参数。"],"notes":"本文最重要结论"},
  {"type":"content","layout":"split","title":"实验结果分析","paragraphs":["XRD与SEM表征证实高固含量导致颗粒团聚至[[5μm]]以上，是性能下降根本原因。"],"notes":"承接方法页"},
  {"type":"content","layout":"card","title":"研究方法","paragraphs":[],"cards":[{"heading":"① 材料制备","points":["• 固含量30/60/100mg/mL","• 喷雾干燥造粒"]},{"heading":"② 结构表征","points":["• SEM/XRD形貌分析","• BET比表面积测定"]}],"flow":true,"notes":"三步流程"},
  {"type":"figure","title":"图1：循环性能对比","figure_desc":"展示三种固含量样品500次循环的容量保持率变化曲线。","analysis":"低固含量89%远优于高固含量61%，团聚是主因。","notes":"核心数据图"},
  {"type":"stats","title":"关键性能参数","stats":[{"value":"89%","unit":"容量保持率","label":"低固含量样品","color":"1B6B3A"},{"value":"61%","unit":"容量保持率","label":"高固含量样品","color":"8B1A1A"}],"notes":"直观对比"},
  {"type":"ending"}
]}

【论文内容】
${keyContent}`;

    // ── SSE 流式调用 AI，边生成边发心跳保活 Nginx 连接 ───────────────────────
    const claudeRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
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
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error("PPT API 错误:", claudeRes.status, err.slice(0, 300));
      return NextResponse.json({ error: `AI 生成失败（HTTP ${claudeRes.status}）` }, { status: 500 });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    void (async () => {
      let rawText = "";
      let sseBuffer = "";
      let inputTokens = 0, outputTokens = 0;

      try {
        const reader = claudeRes.body!.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          await writer.write(encoder.encode(": k\n\n")); // 心跳，重置 Nginx 超时

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

        console.log(`[PPT] 输入 tokens: ${inputTokens}, 输出 tokens: ${outputTokens}`);
        console.log(`[PPT] 原始输出前 300 字: ${rawText.slice(0, 300)}`);

        // JSON 解析（三级容错）
        let pptContent: PptContent;
        try {
          pptContent = parseRawJSON<PptContent>(rawText);
        } catch {
          // 截断容错：找到最后一个完整 slide 后补全结构
          console.error("[PPT] JSON 解析失败，尝试截断补全");
          const stripped = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
          const base = stripped.startsWith("{") ? stripped : '{"slides": ' + stripped;
          const lastSlide = base.lastIndexOf("},");
          if (lastSlide > 0) {
            try {
              pptContent = JSON.parse(base.slice(0, lastSlide + 1) + "]}") as PptContent;
              console.log("[PPT] 截断补全成功，实际页数:", pptContent.slides?.length ?? 0);
            } catch {
              console.error("[PPT] 截断补全失败，原始输出前 500 字:", rawText.slice(0, 500));
              await writer.write(encoder.encode(`data: ${JSON.stringify({ error: "AI 输出格式异常，请重试" })}\n\n`));
              return;
            }
          } else {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: "AI 输出格式异常，请重试" })}\n\n`));
            return;
          }
        }

        if (!pptContent.slides?.length) {
          await writer.write(encoder.encode(`data: ${JSON.stringify({ error: "AI 输出内容为空，请重试" })}\n\n`));
          return;
        }

        console.log("[ppt-layout-debug] 各页 layout 汇总：");
        pptContent.slides.forEach((slide, i) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const s = slide as any;
          const paraPreview = Array.isArray(s.paragraphs) ? `paragraphs[${s.paragraphs.length}]="${String(s.paragraphs[0] ?? "").slice(0, 40)}"` : "no-paragraphs";
          const cardPreview = Array.isArray(s.cards)
            ? `  cards[${s.cards.length}]=${s.cards.map((c: any) => `{h:"${c.heading ?? ""}",pts:${Array.isArray(c.points) ? c.points.length : 0}}`).join(",")}`
            : "";
          console.log(`  [${i + 1}] type=${slide.type}  layout=${s.layout ?? "(无)"}  ${paraPreview}${cardPreview}`);
        });

        if (userId) {
          insertUsageRecord({
            userId, actionType: "ppt_generate",
            tokensInput: inputTokens, tokensOutput: outputTokens,
          }).catch(() => {});
        }

        await writer.write(encoder.encode(`data: ${JSON.stringify({ pptContent })}\n\n`));

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("PPT 生成异常:", msg);
        await writer.write(encoder.encode(`data: ${JSON.stringify({ error: `请求失败：${msg.slice(0, 120)}` })}\n\n`));
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
    const msg = error instanceof Error ? error.message : String(error);
    console.error("PPT 内容生成异常:", msg);
    return NextResponse.json({ error: `请求失败：${msg.slice(0, 120)}` }, { status: 500 });
  }
}
