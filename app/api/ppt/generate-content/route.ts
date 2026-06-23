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
  layout?: "standard" | "split" | "hero";
  title: string;
  paragraphs: string[]; // standard/split: 1-2段叙述段落；hero: [核心数据陈述, 补充说明(可选)]
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

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
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

    const prompt = `你是一位专业的学术PPT设计专家，擅长从论文中提取核心数据并设计内容详实的幻灯片。

【任务】将以下论文内容转化为高质量的PPT结构化大纲，只输出纯 JSON，不要代码块，不要任何说明文字。

【场景】${isDefense ? "毕业/学位答辩（正式学术风格）" : "组会/进展汇报（简洁风格）"}

【页数要求（根据论文复杂程度自行判断，不要固定页数）】
- 简单论文（方法单一、结果较少）：12-15 页
- 普通论文（包含多个实验和对比）：15-20 页
- 复杂论文（多组实验、多维度对比）：20-25 页
${isDefense
  ? "答辩版结构：封面→目录→章节过渡页→内容页→结尾页"
  : "组会版结构：封面→目录→内容页→结尾页（省略章节过渡页）"
}

【内容质量要求】
每页内容要充实详尽，包含论文中的具体数据、实验参数、对比结果。
唯一限制是：每页文字总量控制在能在A4横向页面正常显示的范围内（约200-300字）。
宁可多页少字，也不要一页塞太多内容。

1. 必须从论文中提取真实数据：参数、数值、对比结果，数字要精确
2. content 页用 1-2 段完整段落，不要用列表或要点
3. 每个重要图表（Figure/Table/图/表）生成 1 页 figure 类型
4. 数据密集页面用 stats 或 table，对比分析用 comparison
5. notes 用口语告诉汇报人这页重点讲什么

【不同类型页面的具体要求】

研究背景页（content 类型）：
- 详细说明研究领域现状，如有引用数据请保留
- 说明现有方法或技术的不足之处
- 明确引出本文要解决的核心问题

研究方法页（content 类型）：
- 详细描述实验步骤和流程
- 保留具体参数和数值（如浓度、温度、时间、比例等）
- 说明每个关键步骤的目的和意义

实验结果页（content / figure / stats / table 类型）：
- 必须包含具体测量数据和数值
- 有对比的地方要完整列出各组的对比数据
- 说明数据说明了什么科学问题或支持了什么结论

结论页（content 类型）：
- 详细列出每个创新点，每条都要有具体说明
- 说明对所在领域的贡献和意义
- 可以包含 2-4 个独立的创新点

【可用的幻灯片类型（9种）】

1. cover
{ "type": "cover", "title": "论文完整标题", "subtitle": "专业/课题组名称", "author": "汇报人：xxx\\n指导教师：xxx 职称", "date": "${today}" }

2. contents
{ "type": "contents", "items": ["一、研究背景", "二、研究方法", "三、实验结果", "四、结论"] }

3. section（章节过渡页）
{ "type": "section", "number": "01", "title": "章节标题" }

4. content（内容页，1-2段完整段落，不要用列表，内容要充实）
{ "type": "content", "layout": "standard", "title": "硅基负极材料的挑战", "paragraphs": ["硅作为锂离子电池负极材料，理论比容量高达4200 mAh/g，是商业化石墨（372 mAh/g）的11倍以上。然而，硅在充放电过程中体积膨胀率高达300%，导致材料粉化、SEI膜反复破裂重组，最终造成容量快速衰减，循环稳定性极差，限制了其商业化应用。", "目前主流的改性策略包括纳米化处理、碳包覆和合金化，但均存在制备工艺复杂、成本高、规模化困难等问题。本研究提出采用高固含量浆料工艺制备纳米硅/碳复合材料，在保证材料性能的同时大幅降低制备成本。"], "notes": "重点讲硅的容量优势和体积膨胀这个核心矛盾" }

【layout 字段选取规则——严格遵守，不可随意使用 split/hero】
- "standard"（默认，绝大多数 content 页用这个）：标准版式，适用于背景介绍、研究方法、文献综述、结论展开等所有叙述性内容
- "split"（每篇 PPT 最多 2-3 页，不能更多）：左深色面板+右文字版式，仅用于有明确重要发现或关键结论的页面，判断标准：这页内容是否比其他页更值得视觉突出？
- "hero"（整篇 PPT 最多 1-2 页，不可滥用）：大字强调版式，仅用于全文最核心的单一数据点或最重要的一句话结论；此版式下 paragraphs[0] 是放大显示的核心陈述（如"循环500次后容量保持率达89%，超对比组28个百分点"），paragraphs[1] 是可选补充说明
- 禁止用 split/hero 描述普通方法步骤或背景知识，不能因为"想让页面好看"就乱用

5. figure（图表分析页，每个重要图表一页，内容要详细）
{ "type": "figure", "title": "图1：循环性能对比曲线", "figure_desc": "图表展示了不同固含量样品（30、60、100 mg/mL）在1C倍率下500次循环的容量保持率变化趋势，横轴为循环次数，纵轴为比容量（mAh/g）", "analysis": "高固含量样品（100 mg/mL）经500次循环后容量保持率仅为61%，远低于低固含量样品（30 mg/mL）的89%。这一显著差异表明浆料固含量过高会导致纳米硅颗粒团聚加剧，粒径增大至5 μm以上，从而加速体积膨胀引起的结构破坏。", "notes": "重点强调89%和61%的差距，说明固含量对循环性能的关键影响" }

6. stats（关键数据卡片，有多个重要数值时用）
{ "type": "stats", "title": "页面标题", "stats": [
  { "value": "4200", "unit": "mAh/g", "label": "硅理论比容量", "color": "1B3A8C" },
  { "value": "372", "unit": "mAh/g", "label": "石墨理论比容量", "color": "8B1A1A" },
  { "value": "300%", "unit": "体积膨胀", "label": "充放电过程", "color": "B8600A" }
], "notes": "口语备注" }

7. table（数据表格）
{ "type": "table", "title": "页面标题", "headers": ["样品", "固含量", "粒径D90", "面负载量"], "rows": [
  ["样品A", "30 mg/mL", "2 μm", "0.8 mg/cm²"],
  ["样品B", "100 mg/mL", ">5 μm", "2.0 mg/cm²"]
], "notes": "口语备注" }

8. comparison（并排对比）
{ "type": "comparison", "title": "页面标题", "columns": [
  { "heading": "低固含量（30 mg/mL）", "color": "1B6B3A", "points": ["粒径D90约2 μm，分散均匀", "500次循环容量保持率89%", "面负载量0.8 mg/cm²，偏低"] },
  { "heading": "高固含量（100 mg/mL）", "color": "8B1A1A", "points": ["粒径D90超过5 μm，团聚明显", "500次循环容量保持率仅61%", "面负载量2.0 mg/cm²，满足实用要求"] }
], "notes": "口语备注" }

9. ending
{ "type": "ending" }

【论文内容说明】
以下内容是从论文中提取的摘要、方法、结果、结论等关键部分，请重点从结果和结论部分提取具体数据。

【论文内容】
${keyContent}`;

    // 使用流式请求，边生成边向客户端发心跳，防止 Nginx proxy_read_timeout 断开
    const claudeRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 16000,
        temperature: 0.3,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error("Claude PPT API 错误，状态码:", claudeRes.status, "响应:", err.slice(0, 500));
      return NextResponse.json({ error: `AI 生成失败（HTTP ${claudeRes.status}）：${err.slice(0, 120)}` }, { status: 500 });
    }

    // 建立 SSE 响应流，把心跳和最终 JSON 都通过同一条连接推送
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

          // 每收到一个 chunk 就发一条 SSE 注释，重置 Nginx 超时计时器
          await writer.write(encoder.encode(": k\n\n"));

          // 从 Claude SSE 中提取纯文本内容
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

        // 解析 Claude 输出的 JSON（容错：去掉代码块标记，截取最外层 {} 范围）
        const stripped = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        const jsonStart = stripped.indexOf("{");
        const jsonEnd   = stripped.lastIndexOf("}");
        const cleaned   = (jsonStart !== -1 && jsonEnd > jsonStart)
          ? stripped.slice(jsonStart, jsonEnd + 1)
          : stripped;

        let pptContent: PptContent;
        try {
          pptContent = JSON.parse(cleaned);
        } catch {
          console.error("PPT JSON 解析失败，输出前 800 字：", rawText.slice(0, 800));
          await writer.write(encoder.encode(`data: ${JSON.stringify({ error: "AI 输出格式异常，请重试" })}\n\n`));
          return;
        }

        console.log("=== PPT生成内容 ===");
        console.log(JSON.stringify(pptContent, null, 2));
        console.log("=== 结束 ===");

        // 诊断日志：打印每页类型和 layout 字段，确认 AI 是否输出了 layout
        console.log("[ppt-layout-debug] 各页 layout 汇总：");
        pptContent.slides.forEach((slide, i) => {
          const layoutVal = (slide as Record<string, unknown>).layout ?? "(无 layout 字段)";
          console.log(`  [${i + 1}] type=${slide.type}  layout=${layoutVal}`);
        });

        // 记录用量（fire-and-forget）
        if (userId) {
          insertUsageRecord({
            userId,
            actionType: "ppt_generate",
            tokensInput:  inputTokens,
            tokensOutput: outputTokens,
          }).catch(() => {});
        }

        // 发送最终结果
        await writer.write(encoder.encode(`data: ${JSON.stringify({ pptContent })}\n\n`));

      } catch (err) {
        console.error("PPT 流式生成异常:", err);
        await writer.write(encoder.encode(`data: ${JSON.stringify({ error: "请求失败，请重试" })}\n\n`));
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
