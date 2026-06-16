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

    const prompt = `你是一位专业的学术PPT设计专家，擅长从论文中提取核心数据并设计内容详实、数据丰富的幻灯片。

【任务】将以下论文内容转化为高质量、内容丰富的PPT结构化大纲。

【场景】${isDefense ? "毕业/学位答辩（正式学术风格，20-30页，内容要非常详实）" : "组会/进展汇报（简洁但充实，12-18页）"}

【核心要求】
1. 只输出纯 JSON，不要代码块（不要 \`\`\`），不要任何解释
2. 必须从论文中提取真实数据：实验参数、性能数值、对比结果等，数字要精确
3. 每张 content 页的 points 必须有 4-6 条，每条 20-45 字，包含具体数据或证据
4. 数据密集的页面用 stats 或 table 类型，对比分析用 comparison 类型
5. 检测论文中的图表（关键词：Figure、Table、图、表），为每个重要图表单独生成一页内容说明
6. 每页都必须填写 notes（演讲备注），用 2-3 句口语化表达，告诉汇报人这页该怎么讲
${isDefense
  ? "7. 答辩结构：封面→目录→章节过渡页→内容页→结尾页"
  : "7. 组会结构：封面→目录→内容页→结尾页"
}

【内容丰富度要求】

▶ content 页（普通内容页）——每页必须有 4-6 条详细要点：
- 每条 point 必须是完整句子，格式：「核心观点：具体内容 + 数据（如有）」
- 错误示例：「效率有所提升」
- 正确示例：「转换效率提升：优化后效率从 12.3% 提升至 18.7%，提升幅度达 52%，超过同期对比方法」
- 如论文有数据，每页至少 2 条 point 要包含具体数字

▶ 研究方法页（必须包含）：
- 详细说明实验步骤、材料参数、测试条件
- 如：「样品制备：采用 XX 方法，温度控制在 YY°C，持续 ZZ 小时，固含量为 AA mg/mL」

▶ 结果分析页（必须包含）：
- 必须列出具体实验数值和对比基线
- 必须说明数据的意义（比什么好、好多少、在什么条件下）

▶ 图表说明页（检测到论文中有图表时生成）：
- 标题格式：「图X / 表X：[原图表标题或简短描述]」
- points 格式（4-5条）：
  - 第 1 条：「图表内容：[描述这个图/表展示了什么数据]」
  - 第 2-3 条：「关键发现：[从图表中读出的最重要结论，含具体数字]」
  - 第 4 条：「与对照组对比：[和基线/其他方法相比的差异]」（如有对比数据）
  - 最后 1 条：「研究意义：[这个数据证明了什么结论]」

▶ 结论/创新点页（必须包含）：
- 列出 3-5 个具体创新点，每点说明具体贡献和数据支撑
- 格式：「创新点X：[具体是什么] → 实现了 [具体指标] 提升 [具体数字]」

▶ notes 演讲备注（每页必填，不能为空）：
- 用口语化表达，2-3 句，告诉汇报人该说什么、重点强调什么
- 示例：「这页介绍核心方法，建议先简要说明整体流程，再重点解释第二步的设计思路。数据部分可以结合后面的图表一起讲，预计 1-2 分钟。」

【可用的幻灯片类型（8种）】

1. cover（封面）
{ "type": "cover", "title": "论文完整标题", "subtitle": "专业/课题组名称", "author": "汇报人：xxx\\n指导教师：xxx 职称", "date": "${today}" }

2. contents（目录）
{ "type": "contents", "items": ["一、研究背景与问题", "二、研究方法", "三、实验结果", "四、讨论与结论"] }

3. section（章节过渡页，深色背景）
{ "type": "section", "number": "01", "title": "章节标题" }

4. content（普通内容页——每页 4-6 条详细要点，含数据）
{ "type": "content", "title": "页面标题", "points": ["核心观点1：具体内容，包含数据（如有）", "核心观点2：具体内容，含对比数据", "核心观点3：...", "核心观点4：...（共 4-6 条）"], "notes": "口语化演讲建议，2-3 句告诉汇报人这页怎么讲、重点在哪、大概讲多久" }

5. stats（关键数据卡片页——有多个重要数值时使用）
{ "type": "stats", "title": "页面标题", "stats": [
  { "value": "4200", "unit": "mAh/g", "label": "硅理论比容量", "color": "1B3A8C" },
  { "value": "372", "unit": "mAh/g", "label": "石墨理论比容量", "color": "8B1A1A" },
  { "value": "300%", "unit": "体积膨胀", "label": "充放电过程", "color": "B8600A" }
], "notes": "口语化演讲建议" }

6. table（数据表格——有实验参数表或性能对比表时使用）
{ "type": "table", "title": "页面标题", "headers": ["样品", "固含量", "粒径D90", "面负载量", "首次效率"], "rows": [
  ["样品A", "30 mg/mL", "2 μm", "0.8 mg/cm²", "87.3%"],
  ["样品B", "60 mg/mL", "3.5 μm", "1.4 mg/cm²", "85.1%"],
  ["样品C", "100 mg/mL", ">5 μm", "2.0 mg/cm²", "81.6%"]
], "notes": "口语化演讲建议" }

7. comparison（并排对比——分析不同方案/结果差异时使用）
{ "type": "comparison", "title": "页面标题", "columns": [
  { "heading": "方案A（低固含量 30 mg/mL）", "color": "1B6B3A", "points": ["颗粒分散均匀，粒径约 2 μm", "面负载量低（0.8 mg/cm²），适合薄极片", "首次库伦效率 87.3%，循环性能稳定", "100 圈容量保持率 92%"] },
  { "heading": "方案B（高固含量 100 mg/mL）", "color": "8B1A1A", "points": ["颗粒易团聚，粒径 >5 μm", "面负载量高（2.0 mg/cm²），体积能量密度高", "首次库伦效率 81.6%，初期衰减较快", "50 圈后趋于稳定，长循环性能接近方案A"] }
], "notes": "口语化演讲建议" }

8. ending（结尾页）
{ "type": "ending" }

【论文内容分析优先级】
- 第一步：扫描所有数值数据 → 用 stats 或 table 展示（不要把数据埋在 content 里）
- 第二步：扫描所有图表（Figure / Table / 图 / 表）→ 为每个重要图表生成 1 页 content 说明
- 第三步：识别对比分析内容 → 用 comparison 展示
- 第四步：文字描述性内容 → 用 content 展示（每页 4-6 条详细要点）
- 绝对禁止：把论文数据写成「效果良好」「显著提升」这样的空洞描述，必须写出具体数字

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
        max_tokens: 12000,
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
