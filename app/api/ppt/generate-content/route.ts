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
  title: string;
  paragraphs: string[]; // 1-2 段，每段 50-80 字
  notes: string;
}

export interface FigureSlide {
  type: "figure";
  title: string;
  figure_desc: string;  // 图表展示内容（30-50字）
  analysis: string;     // 从图表得出的结论（50-80字）
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

【场景】${isDefense ? "毕业/学位答辩（正式学术风格，共 14-18 页）" : "组会/进展汇报（简洁风格，共 8-12 页）"}

【⚠️ 字数红线（必须严格遵守，否则输出会被截断报错）】
- content 页每个 paragraph：50-80 字，写完整陈述句（含数据）
- figure 页 figure_desc：30-50 字；analysis：50-80 字
- 每页 notes：最多 40 个字
- 严格控制总页数在上述范围内

【内容质量要求】
1. 必须从论文中提取真实数据：参数、数值、对比结果，数字要精确
2. content 页用 1-2 段完整段落，不要用列表或要点：
   - 第一段：描述实验/研究内容和关键参数（50-80字）
   - 第二段：分析结果和意义，含具体数值（50-80字）
3. 每个重要图表（Figure/Table/图/表）生成 1 页 figure 类型：
   - figure_desc：描述图表展示的数据（30-50字）
   - analysis：从图表得出的结论，含数值（50-80字）
4. 数据密集页面用 stats 或 table，对比分析用 comparison
5. notes 用口语，告诉汇报人这页重点讲什么（40字以内）
${isDefense
  ? "6. 结构：封面→目录→章节过渡页→内容页→结尾页"
  : "6. 结构：封面→目录→内容页→结尾页"
}

【可用的幻灯片类型（9种）】

1. cover
{ "type": "cover", "title": "论文完整标题", "subtitle": "专业/课题组名称", "author": "汇报人：xxx\\n指导教师：xxx 职称", "date": "${today}" }

2. contents
{ "type": "contents", "items": ["一、研究背景", "二、研究方法", "三、实验结果", "四、结论"] }

3. section（章节过渡页）
{ "type": "section", "number": "01", "title": "章节标题" }

4. content（普通内容页，1-2段完整段落，不要用列表）
{ "type": "content", "title": "实验结果分析", "paragraphs": ["第一段：描述实验过程和关键参数，含具体数值（50-80字）", "第二段：分析结果和科学意义，含具体数字（50-80字）"], "notes": "口语备注，≤40字" }

5. figure（图表分析页，每个重要图表一页）
{ "type": "figure", "title": "图1：循环性能曲线", "figure_desc": "图表展示了不同电流密度下500次循环的容量保持率变化趋势", "analysis": "1C下经500次循环容量保持率达89%，远高于对照组76%，表明材料具有优异的循环稳定性，充分证明包覆层有效抑制了体积膨胀", "notes": "口语备注，≤40字" }

6. stats（关键数据卡片，有多个重要数值时用）
{ "type": "stats", "title": "页面标题", "stats": [
  { "value": "4200", "unit": "mAh/g", "label": "硅理论比容量", "color": "1B3A8C" },
  { "value": "372", "unit": "mAh/g", "label": "石墨理论比容量", "color": "8B1A1A" },
  { "value": "300%", "unit": "体积膨胀", "label": "充放电过程", "color": "B8600A" }
], "notes": "口语备注，≤40字" }

7. table（数据表格）
{ "type": "table", "title": "页面标题", "headers": ["样品", "固含量", "粒径D90", "面负载量"], "rows": [
  ["样品A", "30 mg/mL", "2 μm", "0.8 mg/cm²"],
  ["样品B", "100 mg/mL", ">5 μm", "2.0 mg/cm²"]
], "notes": "口语备注，≤40字" }

8. comparison（并排对比）
{ "type": "comparison", "title": "页面标题", "columns": [
  { "heading": "方案A", "color": "1B6B3A", "points": ["要点1（≤20字）", "要点2", "要点3"] },
  { "heading": "方案B", "color": "8B1A1A", "points": ["要点1（≤20字）", "要点2", "要点3"] }
], "notes": "口语备注，≤40字" }

9. ending
{ "type": "ending" }

【论文内容说明】
以下内容是从论文中提取的摘要、方法、结果、结论等关键部分，请重点从结果和结论部分提取数据。

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
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error("Claude PPT 内容生成错误:", err);
      return NextResponse.json({ error: "AI 生成失败，请重试" }, { status: 500 });
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
    console.error("PPT 内容生成异常:", error);
    return NextResponse.json({ error: "请求失败，请重试" }, { status: 500 });
  }
}
