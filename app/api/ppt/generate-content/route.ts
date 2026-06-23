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
  cards?: Array<{ heading: string; points: string[] }>; // card 版式专用：2-3 个并列主题卡片，每卡含标题和要点
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

【关键词高亮标记（[[双方括号]]）】
在要点里，把最关键的 1-2 个词/数值用 [[双方括号]] 标记，渲染时自动显示为红色加粗。
✅ 用于：核心数值（[[300%]]）、关键方法名（[[高固含量浆料]]）、核心结论（[[89%容量保持率]]）
⛔ 不用于：修饰词（"显著""大幅"等）、整句话、连续多处高亮
⛔ 每条要点最多标记 1-2 处，禁止满屏红字
示例：
✅ "• 体积膨胀高达 [[300%]]，充放电时颗粒粉化、极片开裂，容量急剧衰减"
✅ "• [[SEI膜反复破裂再生]]，持续消耗电解液，循环寿命缩短至200次以下"
❌ "• [[体积膨胀]]高达[[300%]]，[[充放电]]时[[颗粒粉化]]" （过度标记，禁止）
注意：[[]] 标记只在 paragraphs 和 cards[i].points 的要点字符串里用，不要出现在 title、notes、heading 里。

【内容质量要求】
⛔ 禁止整段照搬论文文字。PPT 不是论文翻译，不要把原文段落直接复制进去。
⛔ 禁止只写干巴巴结论，不带数据和因果。"• SEI膜反复破裂"是废话；"• SEI膜反复破裂，持续消耗电解液，循环50次后容量保持率降至60%"才有信息量。

✅ 每个 paragraphs 条目 = 一个完整要点：• 开头 + 核心结论 + 关键数据或因果支撑。
   参考长度 35-40 字；关键信息装不下时可到 50 字。
   ★ 优先级：保留关键信息和数据是第一位，精简是第二位。不要为了短而砍掉因果链。

1. 必须从论文中提取真实数据：参数、数值、对比结果，数字要精确
2. content 页用 4-6 个完整要点（paragraphs 数组 4-6 条），每条格式：• + 核心结论 + 支撑数据/因果
3. 每个重要图表（Figure/Table/图/表）生成 1 页 figure 类型
4. 数据密集页面用 stats 或 table，对比分析用 comparison
5. notes 用口语告诉汇报人这页重点讲什么

【内容→版式快速判断】
- 包含全文最关键单一数据点/结论（一句话说得清）→ hero 版式
- 内容是并列/对比关系（A组 vs B组、优点 vs 缺点、改进前 vs 改进后）→ split 版式
- 内容能明确分成 2-3 个并列子主题（每组有独立标题，每组 2-4 个要点）→ card 版式
- 叙述性背景/文献综述/单一线性流程 → standard 版式

【不同类型页面的具体要求（每条以 • 开头，含数据或因果，参考 35-40 字）】

研究背景页（content 类型，standard版式，4-5条）：
• 要点1：领域现状 + 关键引用数据（数字必须保留）
• 要点2：现有方法/技术的核心缺陷 + 为什么是缺陷（一句话说清楚）
• 要点3：本文解决的问题（一句话点题）
• 要点4-5（可选）：本文方法/思路的核心一句话 + 预期效果

研究方法页（content 类型，standard版式，4-6条）：
• 每条 = 一个步骤 + 关键参数数值 + 为什么这样设置（如有）
• 禁止写"首先……然后……最后……"，直接写步骤+数值
• 示例："浆料配制：固含量100 mg/mL（NMP为溶剂），高固含量减少烘干时间约40%"

实验结果页（content / figure / stats / table 类型）：
• 单一最重要数据 → hero版式，paragraphs[0]直接写该数据结论（含数值和比较基准）
• 多组对比数据 → comparison 或 split版式，分列对比
• 有表格数据 → table类型直接呈现，禁止放进content段落里文字描述

结论页（content 类型，split版式优先，4-5条）：
• 每条 = 一个创新点 + 效果数据，格式："• 提出/实现/验证了 X，结果/效果 Y"
• 示例："• 提出高固含量浆料工艺，制备成本较传统工艺降低40%，性能保持率≥90%"
• 每条必须有可量化结果，宁少勿多

【可用的幻灯片类型（9种）】

1. cover
{ "type": "cover", "title": "论文完整标题", "subtitle": "专业/课题组名称", "author": "汇报人：xxx\\n指导教师：xxx 职称", "date": "${today}" }

2. contents
{ "type": "contents", "items": ["一、研究背景", "二、研究方法", "三、实验结果", "四、结论"] }

3. section（章节过渡页）
{ "type": "section", "number": "01", "title": "章节标题" }

4. content（内容页，4-6个完整要点，每条以 • 开头 + 核心结论 + 数据/因果，禁止照搬原文，也禁止只写空洞结论）
{ "type": "content", "layout": "standard", "title": "硅基负极材料的挑战", "paragraphs": ["• 硅理论比容量4200 mAh/g，是石墨的11倍，能量密度提升潜力巨大", "• 充放电体积膨胀高达300%，导致颗粒粉化、极片开裂、容量快速衰减", "• SEI膜反复破裂再生，持续消耗电解液，循环寿命严重缩短", "• 现有纳米化/碳包覆方案成本高昂，难以规模化量产"], "notes": "重点讲硅的容量优势和体积膨胀这个核心矛盾，以及为什么现有方案不够好" }

⚠️ 对比好坏示例：
❌ 错误（照搬原文长段）："本研究在充分分析现有硅基负极材料所面临的体积膨胀问题基础上，提出了一种基于高固含量浆料工艺的纳米硅碳复合制备方法，在保证材料性能的同时大幅降低制备成本"
❌ 错误（过度精简，空洞无信息）：["• 体积膨胀大", "• SEI膜破裂", "• 成本高"] ← 读者不知道多大、为什么、多少钱，没有信息量
✅ 正确（完整要点，含数据和因果）：["• 硅体积膨胀高达300%，充放电时颗粒粉化、极片开裂，容量急剧衰减", "• SEI膜反复破裂再生，持续消耗电解液，循环寿命缩短至200次以下", "• 现有纳米化工艺成本是石墨负极的5-10倍，难以量产"]

【layout 字段——硬性要求，违反视为错误输出】

⛔ 绝对禁止：所有 content 页都输出 "standard"。如果你的草稿里所有 content 页都是 standard，必须修改。
✅ 强制要求（按 content 页总数比例计算，先数清楚再决定）：
  - hero：content 页 ≤ 8 时用 1 页；content 页 > 8 时用 2 页。hero 不超过 2 页（过多则审美疲劳）
  - split：content 页总数 ÷ 3，向上取整，且不少于 2 页。split 不超过 content 总数的 40%
  - card：当页面内容自然分成 2-3 个子主题时使用，不占 split 配额，独立判断；建议每篇论文出现 1-3 次
  - 示例：content 共 9 页 → split ≥ 3 页，hero = 2 页，card 1-2 页，其余 standard

内容→版式的映射规则（按此执行，不得偏离）：

▸ "hero"（必须出现 1-2 次）
  - 用于：全文最亮眼的单一实验数据或核心结论，例如"循环500次容量保持率89%"
  - 判断：这页包含全文最关键的一个数字/发现，是你最想让观众记住的那一句话
  - 写法：paragraphs[0] 是大字显示的核心陈述（20-40字，必须含具体数值），paragraphs[1] 可选补充说明
  - 典型标题例：「核心发现」「关键性能指标」「本文最重要的结论」

▸ "split"（必须出现 2-3 次）
  - 用于：有明确研究发现或实验结论的页面
  - 判断：这页是在陈述"我们发现了什么/证明了什么"，而不是在叙述"我们做了什么步骤"
  - 典型标题例：「主要结论」「实验结果分析」「研究贡献」「结论与展望」

▸ "card"（内容有 2-3 个并列子主题时使用）
  - 用于：多步骤方法（每步骤独立一张卡片）、多维度对比（性能/成本/稳定性各一张）、并列知识点介绍
  - 判断：这页内容可以拆成 2-3 个有独立标题的"子话题"，每个子话题各自有 2-4 个要点
  - 写法：cards 数组，每项含 heading（卡片标题，5-12字）和 points（2-4个要点，以 • 开头，含数据/因果）；paragraphs 留空数组 []
  - 典型标题例：「研究方法概述」「三大创新点」「材料制备与表征」「多维度性能评估」

▸ "standard"（其余叙述页用）
  - 用于：研究背景、文献综述、研究动机、单一线性流程等纯叙述性内容
  - 这类页面没有明确"发现/结论"，也不能自然分组，只是在交代背景或过程

card 版式（并列主题，无顺序）：
{ "type": "content", "layout": "card", "title": "多维度性能评估", "paragraphs": [], "cards": [
  { "heading": "容量性能", "points": ["• 首次放电比容量 [[1850 mAh/g]]，是石墨理论值的5倍", "• 100次循环后容量保持率 [[89%]]，优于传统工艺的72%"] },
  { "heading": "倍率性能", "points": ["• 5C倍率下仍保留 [[78%]] 首次容量，快充能力突出", "• 阻抗谱（EIS）显示SEI膜稳定，界面阻抗未见显著增大"] },
  { "heading": "成本对比", "points": ["• 制备成本较传统纳米化工艺降低 [[40%]]", "• 浆料固含量提升5倍，烘干时间缩短约 [[60%]]"] }
], "flow": false, "notes": "三列并排展示性能、倍率、成本三个维度，不加箭头" }

card 版式（流程顺序，有箭头）：
{ "type": "content", "layout": "card", "title": "研究方法概述", "paragraphs": [], "cards": [
  { "heading": "① 材料制备", "points": ["• [[高固含量浆料]]（100 mg/mL）制备纳米硅/碳复合材料", "• 喷雾干燥造粒，D50粒径控制在 [[150 nm]]"] },
  { "heading": "② 结构表征", "points": ["• SEM/XRD确认颗粒形貌与碳包覆结晶度（IG/ID = 1.2）", "• BET测定比表面积，评估团聚程度"] },
  { "heading": "③ 电化学测试", "points": ["• [[0.1–5C]] 倍率循环，评估容量与倍率性能", "• EIS阻抗谱分析SEI膜稳定性"] }
], "flow": true, "notes": "三步实验流程有明确先后顺序，卡片间显示流程箭头" }

【flow 字段规则（card 版式专用）】
- flow: true  → 卡片之间有明确先后/顺序关系（步骤1→2→3、阶段一→二→三、制备→表征→测试）
- flow: false 或省略 → 卡片是并列关系（多维度评估、优缺点对比、不同材料对比）
- 判断口诀：能说"先做A，再做B，最后C"→ flow:true；能说"从X角度/Y角度看"→ flow:false
- 有顺序的卡片建议在 heading 里加 ①②③ 序号，让观众一眼看清顺序

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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const layoutVal = (slide as any).layout ?? "(无 layout 字段)";
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
