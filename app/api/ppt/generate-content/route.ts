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
  points: string[]; // 每条最多 40 字，最多 6 条
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
  | ComparisonSlide;

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

    const isDefense = scene === "defense";
    const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" });

    const prompt = `你是一位专业的学术PPT设计专家，擅长从论文中提取核心数据并设计信息丰富的幻灯片。

【任务】将以下论文内容转化为高质量的PPT结构化大纲。

【场景】${isDefense ? "毕业/学位答辩（正式学术风格，20-25页）" : "组会/进展汇报（简洁风格，10-15页）"}

【核心要求】
1. 只输出纯 JSON，不要代码块（不要 \`\`\`），不要任何解释
2. 必须从论文中提取真实数据：实验参数、性能数值、对比结果等
3. 数据密集的页面使用 stats 或 table 类型，不要用 content 类型浪费
4. 每张 content 页的 points 最多 6 条，每条最多 40 字（可以写完整句子）
5. 对比分析优先使用 comparison 类型
${isDefense
  ? "6. 答辩结构：封面→目录→章节过渡页→内容页→结尾页"
  : "6. 组会结构：封面→目录（可选）→内容页（无章节过渡页）→结尾页"
}

【可用的幻灯片类型（7种）】

1. cover（封面）
{ "type": "cover", "title": "论文标题", "subtitle": "专业/课题", "author": "汇报人：xxx\\n指导教师：xxx 职称", "date": "${today}" }

2. contents（目录）
{ "type": "contents", "items": ["第一章 章节名", "第二章 章节名"] }

3. section（章节过渡页，深色背景）
{ "type": "section", "number": "01", "title": "章节标题" }

4. content（普通内容页，要点列表）
{ "type": "content", "title": "页面标题", "points": ["完整的要点句子，可以写40字以内", "..."], "notes": "演讲者备注，2-3句话扩展内容" }

5. stats（关键数据卡片页——有多个重要数值时使用）
{ "type": "stats", "title": "页面标题", "stats": [
  { "value": "4200", "unit": "mAh/g", "label": "硅理论比容量", "color": "1B3A8C" },
  { "value": "372", "unit": "mAh/g", "label": "石墨理论比容量", "color": "8B1A1A" },
  { "value": "300%", "unit": "体积膨胀", "label": "充放电过程", "color": "B8600A" }
], "notes": "演讲者备注" }

6. table（数据表格——有实验参数表或性能对比表时使用）
{ "type": "table", "title": "页面标题", "headers": ["样品", "固含量", "粒径D90", "面负载量"], "rows": [
  ["样品A", "30 mg/mL", "2 μm", "0.8 mg/cm²"],
  ["样品B", "60 mg/mL", "3.5 μm", "1.4 mg/cm²"],
  ["样品C", "100 mg/mL", ">5 μm", "2.0 mg/cm²"]
], "notes": "演讲者备注" }

7. comparison（并排对比——分析不同方案/结果差异时使用）
{ "type": "comparison", "title": "页面标题", "columns": [
  { "heading": "低固含量（30 mg/mL）", "color": "1B6B3A", "points": ["颗粒分散均匀", "粒径约2μm", "面负载量低（0.8 mg/cm²）", "初期循环稳定"] },
  { "heading": "高固含量（100 mg/mL）", "color": "8B1A1A", "points": ["颗粒易团聚", "粒径>5μm", "面负载量高（2.0 mg/cm²）", "初期衰减快但后期稳定"] }
], "notes": "演讲者备注" }

8. ending（结尾页）
{ "type": "ending" }

【论文内容分析优先级】
- 首先识别论文中的所有数值数据 → 放入 stats 或 table
- 然后识别对比分析内容 → 放入 comparison
- 文字描述性内容 → 放入 content
- 避免把表格数据写成 content 的 points

【论文内容】
${paperContent.slice(0, 24000)}`;

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

        // 解析 Claude 输出的 JSON
        const cleaned = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        let pptContent: PptContent;
        try {
          pptContent = JSON.parse(cleaned);
        } catch {
          console.error("PPT JSON 解析失败，原始输出：", rawText.slice(0, 500));
          await writer.write(encoder.encode(`data: ${JSON.stringify({ error: "AI 输出格式异常，请重试" })}\n\n`));
          return;
        }

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
