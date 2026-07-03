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

// ── 两阶段生成辅助函数 ────────────────────────────────────────────────────────

/** 非流式 AI 调用，返回文本 + token 用量 */
async function callAISingle(
  apiKey: string,
  prompt: string,
  maxTokens: number,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const res = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
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
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI HTTP ${res.status}: ${err.slice(0, 120)}`);
  }
  const data = await res.json();
  return {
    text: data.content?.[0]?.text ?? "",
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

/** 解析 AI 输出的 JSON，带截断容错 */
function parseRawJSON<T>(rawText: string): T {
  const stripped = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const s = stripped.indexOf("{");
  const e = stripped.lastIndexOf("}");
  const cleaned = s !== -1 && e > s ? stripped.slice(s, e + 1) : stripped;
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // 截断容错：找最后一个完整的 } 尝试补全
    const base = s !== -1 ? stripped.slice(s) : stripped;
    const lastClose = base.lastIndexOf("}");
    if (lastClose > 0) {
      try { return JSON.parse(base.slice(0, lastClose + 1)) as T; } catch {}
    }
    throw new Error("JSON 解析失败");
  }
}

// ─────────────────────────────────────────────────────────────────────────────

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

    // ── 第一阶段提示词：只生成骨架（无正文），保证 token 不截断 ──────────────
    const skeletonPrompt = `你是一位专业的学术PPT设计专家。

【任务——骨架阶段】根据论文生成完整的PPT骨架，只输出纯 JSON，不要代码块，不要说明文字。

⚠️ 这是两阶段生成的第一阶段，正文内容由第二阶段填充。骨架阶段的强制约束：
- content 页：只填 type、layout、title，paragraphs 必须写 []，notes 必须写 ""
- figure 页：只填 type、title，figure_desc 写 ""，analysis 写 ""，notes 写 ""
- cover / contents / section / ending：填写完整内容（字段本来就很短）
- stats / table / comparison：填写完整数据（字段本来就很短）

【一致性要求——最高优先级，违反视为严重错误】
- 必须按照论文的实际章节结构生成，章节标题直接从论文提取原文，不得自行概括或改写
- 严格按照论文从头到尾的顺序生成，不得跳过任何章节，不得合并或拆分章节
- 论文中每一个实验、每一组数据、每一个结论都必须体现在对应页面中，不得遗漏
- 每次生成同一篇论文，章节结构和页面顺序必须保持一致，不得因随机性导致结构变化

【场景】${isDefense ? "毕业/学位答辩（正式学术风格）" : "组会/进展汇报（简洁风格）"}

【页数要求（根据论文复杂程度自行判断，不要固定页数）】
- 简单论文（方法单一、结果较少）：12-15 页
- 普通论文（包含多个实验和对比）：15-20 页
- 复杂论文（多组实验、多维度对比）：20-25 页
${isDefense
  ? "答辩版结构：封面→目录→章节过渡页→内容页→结尾页"
  : "组会版结构：封面→目录→内容页→结尾页（省略章节过渡页）"
}

【layout 选择规则（每个 content 页必须认真判断，⛔ 禁止全部输出 standard）】
- hero：全文最关键单一数据/结论，最多 2 页
- split：研究发现/实验结论，content 总数 ÷ 3 向上取整，至少 2 页
- card：内容分 2-3 个并列子主题时用（card 版式 paragraphs 填 []，需有 cards 数组）
- standard：研究背景/文献综述/叙述性内容

【cover 字段提取规则（必须从论文正文仔细查找）】
- 作者姓名：① 标题页作者署名 → ② 摘要前作者列表 → ③ 页眉/页脚署名
- 导师姓名：① 致谢中"感谢XXX教授/导师" → ② 通讯作者（*标注）
- 找不到的字段留空字符串 ""，绝对不要写"XXX"、"某某"等占位符
- author 格式："汇报人：[第一作者姓名]\\n指导教师：[导师姓名职称]"（找不到留空）

【骨架 JSON 输出格式】
{"title":"论文标题","scene":"defense","total_pages":N,"slides":[
  {"type":"cover","title":"...","subtitle":"...","author":"...","date":"${today}"},
  {"type":"contents","items":["一、研究背景","二、研究方法","..."]},
  {"type":"section","number":"01","title":"章节标题"},
  {"type":"content","layout":"standard","title":"页面标题","paragraphs":[],"notes":""},
  {"type":"content","layout":"card","title":"研究方法","paragraphs":[],"cards":[{"heading":"① 材料制备","points":["• 关键步骤1","• 关键步骤2"]}],"flow":true,"notes":""},
  {"type":"figure","title":"图1：标题","figure_desc":"","analysis":"","notes":""},
  {"type":"stats","title":"...","stats":[{"value":"4200","unit":"mAh/g","label":"硅理论比容量","color":"1B3A8C"}],"notes":"口语备注"},
  {"type":"table","title":"...","headers":["样品","参数"],"rows":[["A","值1"]],"notes":"口语备注"},
  {"type":"comparison","title":"...","columns":[{"heading":"方案A","color":"1B6B3A","points":["• 要点1"]}],"notes":"口语备注"},
  {"type":"ending"}
]}

⚠️ content 页的 paragraphs 必须是 []，notes 必须是 ""（第二阶段填充）
⚠️ card 版式需要填写 cards 数组（cards 字段很短，直接在骨架里写完整）
⚠️ stats/table/comparison 需要填写完整数据（这些字段本来就很短）

【论文内容】
${keyContent}`;

    // ── 构建填充阶段提示词（用于第二阶段逐批填充正文）─────────────────────────
    const buildFillPrompt = (
      batchSlides: Slide[],
      allSlides: Slide[],
      batchStartIdx: number,
    ): string => {
      const totalPages = allSlides.length;
      const slidesSummary = allSlides
        .map((s, i) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const layout = (s as any).layout ? ` [${(s as any).layout}]` : "";
          return `  第${i + 1}页: ${s.type}${layout} - ${(s as any).title ?? ""}`;
        })
        .join("\n");
      const prevIdx = batchStartIdx - 1;
      const nextIdx = batchStartIdx + batchSlides.length;
      const prevSlide = prevIdx >= 0 ? allSlides[prevIdx] : null;
      const nextSlide = nextIdx < totalPages ? allSlides[nextIdx] : null;

      return `你是专业的学术PPT内容撰写专家。这是两阶段生成的第二阶段：请为以下 ${batchSlides.length} 页幻灯片填充详细正文内容。

【任务】只输出纯 JSON，格式为 {"slides":[...]}，包含这 ${batchSlides.length} 页的完整内容，顺序与输入一致，不要代码块，不要说明文字。

【整篇PPT结构（共 ${totalPages} 页，仅供参考）】
${slidesSummary}

${prevSlide ? `【上一页内容（衔接参考）】\n${JSON.stringify(prevSlide, null, 2)}\n` : ""}
${nextSlide ? `【下一页内容（衔接参考）】\n${JSON.stringify(nextSlide, null, 2)}\n` : ""}

【需要填充正文的页面骨架】
${JSON.stringify(batchSlides, null, 2)}

【内容格式要求——最高优先级，违反视为错误输出】

★ paragraphs 字段（standard / split 版式）：
  - 1-2 个完整段落字符串，每段 3-5 句话，每段不少于 80 字
  - 段落是流畅陈述性文字，不加"•"符号，不分条罗列
  - 每段必须包含：核心观点 + 支撑数据 + 因果说明，三者缺一不可
  ⛔ 禁止 bullet point 格式（"• 某某"）出现在 paragraphs 里
  ⛔ 禁止空洞表述"本研究具有重要意义"——必须附具体数值和因果

★ hero 版式 paragraphs：
  - paragraphs[0]：大字显示的核心陈述，1句话，20-40字，必须含具体数值
  - paragraphs[1]（可选）：1-2句补充说明，解释意义或对比基准

★ card 版式：paragraphs 保持 []；cards 数组已在骨架中，无需更改——只填 notes 字段即可

★ figure 类型：
  - figure_desc（2-3句）：描述图表展示了什么数据，横纵轴含义，趋势或分布
  - analysis（2-3句）：从图表得出的核心结论，含具体数值、机理解释和意义

★ 关键词高亮（[[双方括号]]）：
  - 在 paragraphs 里把最关键的 1-2 个词/数值用 [[双方括号]] 标记（渲染为红色加粗）
  - 每段最多 2-3 处；禁止用于 title、notes、heading 字段

★ notes 字段：口语说明"上页讲了什么 → 这页讲什么 → 引出下页什么"，一句话即可

【跨页逻辑连贯性】
- 参考上下页内容，确保这批页面的开头自然承接上一页，结尾自然引出下一页
- 同一概念首次出现时详述，后续页直接引用不要重复解释

【论文内容（从中提取真实数据，数字要精确）】
${keyContent}`;
    };

    // ── 建立 SSE 响应，用心跳保活 Nginx 连接 ─────────────────────────────────
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    void (async () => {
      let totalInput = 0, totalOutput = 0;

      // 每 8 秒发一次心跳，防止 Nginx proxy_read_timeout 断开
      const heartbeat = setInterval(async () => {
        try { await writer.write(encoder.encode(": k\n\n")); } catch {}
      }, 8000);

      try {
        // ── 第一阶段：生成骨架 ─────────────────────────────────────────────────
        console.log("[PPT Pass1] 开始生成骨架...");
        const { text: skeletonText, inputTokens: in1, outputTokens: out1 } =
          await callAISingle(apiKey, skeletonPrompt, 12000);
        totalInput += in1; totalOutput += out1;
        console.log(`[PPT Pass1] 完成 | 输入 tokens: ${in1}, 输出 tokens: ${out1}`);

        const skeleton = parseRawJSON<PptContent>(skeletonText);
        if (!skeleton.slides?.length) throw new Error("骨架解析失败或 slides 为空");
        console.log(`[PPT Pass1] 骨架页数: ${skeleton.slides.length}`);

        // ── 第二阶段：逐批填充正文（每批 3 页）──────────────────────────────────
        const BATCH = 3;
        const fillTargets = skeleton.slides
          .map((s, i) => (["content", "figure"].includes(s.type) ? i : -1))
          .filter(i => i >= 0);

        console.log(`[PPT Pass2] 需填充页数: ${fillTargets.length}，分 ${Math.ceil(fillTargets.length / BATCH)} 批`);

        for (let b = 0; b < fillTargets.length; b += BATCH) {
          const batchIndices = fillTargets.slice(b, b + BATCH);
          const batchSlides  = batchIndices.map(i => skeleton.slides[i]);
          const fillPrompt   = buildFillPrompt(batchSlides, skeleton.slides, batchIndices[0]);

          await writer.write(encoder.encode(": k\n\n")); // 填充批次间发心跳

          const batchNum = Math.floor(b / BATCH) + 1;
          console.log(`[PPT Pass2 batch ${batchNum}] 填充页索引: [${batchIndices.join(",")}]`);

          const { text: fillText, inputTokens: in2, outputTokens: out2 } =
            await callAISingle(apiKey, fillPrompt, 8000);
          totalInput += in2; totalOutput += out2;
          console.log(`[PPT Pass2 batch ${batchNum}] 完成 | 输入 tokens: ${in2}, 输出 tokens: ${out2}`);

          const fillResult = parseRawJSON<{ slides: Slide[] }>(fillText);
          batchIndices.forEach((slideIdx, batchPos) => {
            const filled = fillResult.slides?.[batchPos];
            if (filled) {
              skeleton.slides[slideIdx] = { ...skeleton.slides[slideIdx], ...filled };
            }
          });
        }

        console.log(`[PPT 总计] 输入 tokens: ${totalInput}, 输出 tokens: ${totalOutput}`);
        console.log("[ppt-layout-debug] 各页 layout 汇总：");
        skeleton.slides.forEach((slide, i) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const layoutVal = (slide as any).layout ?? "(无)";
          console.log(`  [${i + 1}] type=${slide.type}  layout=${layoutVal}`);
        });

        // 记录用量
        if (userId) {
          insertUsageRecord({
            userId, actionType: "ppt_generate",
            tokensInput: totalInput, tokensOutput: totalOutput,
          }).catch(() => {});
        }

        await writer.write(encoder.encode(`data: ${JSON.stringify({ pptContent: skeleton })}\n\n`));

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("PPT 两阶段生成异常:", msg);
        await writer.write(encoder.encode(`data: ${JSON.stringify({ error: `请求失败：${msg.slice(0, 120)}` })}\n\n`));
      } finally {
        clearInterval(heartbeat);
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
