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
在段落正文里，把最关键的 1-2 个词/数值用 [[双方括号]] 标记，渲染时自动显示为红色加粗。
✅ 用于：核心数值（[[300%]]）、关键方法名（[[高固含量浆料]]）、核心结论（[[89%容量保持率]]）
⛔ 不用于：修饰词（"显著""大幅"等）、整句话、连续多处高亮
⛔ 每个段落最多标记 2-3 处，禁止满屏红字
示例：
✅ "硅在充放电过程中体积膨胀高达 [[300%]]，导致颗粒粉化、SEI膜反复破裂，循环寿命急剧下降。"
✅ "本文提出的[[高固含量浆料工艺]]使制备成本较传统方案降低40%，同时保持容量保持率 [[89%]]。"
❌ "[[体积膨胀]]高达[[300%]]，[[充放电]]时[[颗粒粉化]]、[[SEI膜]]反复[[破裂]]" （过度标记，禁止）
注意：[[]] 标记只在 paragraphs 段落字符串里用，不要出现在 title、notes、heading、cards[i].heading 里。

【内容格式要求——最高优先级，违反视为错误输出】

★ paragraphs 字段的核心格式规则（standard / split / hero 版式适用）：
  - paragraphs = 1-2 个完整段落字符串，每个段落 3-5 句话，每个段落不少于 80 字
  - 段落是流畅的陈述性文字，不加"•"符号，不分条罗列
  - 两个段落之间可以从不同角度展开（如：第一段讲现象/背景，第二段讲原因/结论）
  - 每段至少包含：核心观点 + 支撑数据 + 因果说明，三者缺一不可

⛔ 禁止使用 bullet point 格式（"• 某某某"）放进 paragraphs 数组——这是只属于 card.points 的格式
⛔ 禁止每页只有标题没有正文，每个 content 页的 paragraphs 至少 1 个实质性段落
⛔ 禁止空洞表述如"本研究具有重要意义"、"结果表明性能良好"——必须附具体数值和因果
⛔ 禁止生成空白占位符（"请插入图片"等）。没有对应图片时用 card+flow:true 文字流程图

1. 必须从论文中提取真实数据：参数、数值、对比结果，数字要精确
2. content 页（standard/split）：paragraphs 写 1-2 个完整段落，每段 80-150 字，体现因果深度
3. 每个重要图表（Figure/Table/图/表）生成 1 页 figure 类型（figure_desc 和 analysis 都要详细，各 2-3 句）
4. 数据密集页面用 stats 或 table，对比分析用 comparison
5. notes 用口语告诉汇报人"这页承接上页什么内容"+"这页引出下页什么内容"

【跨页逻辑连贯性要求——违反视为错误输出】

★ 整体叙事结构：
  - PPT 的所有页面必须构成一条完整的逻辑链：提出问题 → 分析原因 → 提出方法 → 展示结果 → 得出结论
  - 每一页的内容必须能从上一页自然引出，不得出现话题突然跳转或重复已讲内容

★ 章节内部连贯性：
  - 同一章节的相邻两页之间，后一页的开头应承接前一页的结尾逻辑
  - 禁止同一概念/数据在不同页面重复解释，第一次出现时详述，后续页直接引用
  - 结果页必须能对应到方法页中提到的具体实验步骤，不得凭空出现未介绍过的方法

★ 章节过渡页（section）之后的第一页：
  - 必须用一句话承接该章节要回答的核心问题，不得直接跳入细节

★ notes 字段的连贯性要求：
  - 每页的 notes 必须提示汇报人"这页承接上页的什么内容"以及"这页引出下页的什么内容"
  - 格式示例："上页介绍了体积膨胀问题，这页展示我们如何通过高固含量工艺解决它，讲完引出下页的实验验证"

【内容→版式快速判断】
- 包含全文最关键单一数据点/结论（一句话说得清）→ hero 版式
- 内容是并列/对比关系（A组 vs B组、优点 vs 缺点、改进前 vs 改进后）→ split 版式
- 内容能明确分成 2-3 个并列子主题（每组有独立标题，每组 2-4 个要点）→ card 版式
- 叙述性背景/文献综述/单一线性流程 → standard 版式

【不同类型页面的具体内容要求】

研究背景页（content 类型，standard版式，paragraphs 写 2 个段落）：
⚠️ 两个段落必须覆盖三层逻辑，缺一不可：
  段落一：① 领域背景 + 具体数据（交代研究价值）→ ② 现有方案的核心缺陷及其危害（有数字更好）
  段落二：③ 缺陷的根本原因（为什么现有方案解决不了）→ ④ 本文提出的解决思路（具体方法，非空泛描述）
示例段落一："锂离子电池硅基负极材料理论比容量高达4200 mAh/g，是商用石墨（372 mAh/g）的11倍以上，被视为下一代高能量密度电池的核心材料。然而，硅在充放电过程中体积膨胀达[[300%]]，导致颗粒持续粉化、SEI膜反复破裂，循环200次后容量保持率普遍低于60%，严重制约其商业化进程。现有纳米化与碳包覆方案虽有所改善，但制备成本是石墨负极的5-10倍，工艺复杂度高，难以规模化量产。"
示例段落二："问题的根源在于浆料加工阶段固含量过低（通常低于30 mg/mL），导致纳米硅颗粒在干燥过程中团聚加剧，最终粒径超过5 μm，体积膨胀效应成倍放大。本文提出[[高固含量浆料工艺]]，将固含量提升至100 mg/mL，通过控制颗粒间距抑制团聚，同时验证该工艺对电化学性能的实质影响。"

研究方法页（card 版式 + flow:true，每张卡片对应一个步骤）：
- heading 用 ①②③ 序号标注步骤
- points 写 2-3 条关键参数和操作要点（保留 • 开头，简洁即可）
- 没有对应实验图片时直接用 card 文字版，不留图片占位符

实验流程/技术路线（card+flow:true，不生成 figure 类型）：
- 每张卡片 = 一个阶段，heading 标注顺序，points 写关键参数
- 只有论文中真实存在的图表（Figure N / 图N）才生成 figure 类型页面

实验结果页（content / figure / stats / table 类型，paragraphs 写 1-2 个段落）：
- 单一最重要数据 → hero版式，paragraphs[0] = 完整陈述句（含数值、对比基准、意义，20-40字）
- 图表分析 → figure 类型，figure_desc 描述图表内容（2-3句），analysis 解释机理+意义（2-3句）
- 多组对比 → comparison 或 split 版式
- 有表格 → table 类型直接呈现
- 文字分析页 → content + split/standard，paragraphs 写段落（每段80-120字，含现象+机理+结论三层）

结论页（content 类型，split版式，paragraphs 写 2 个段落）：
- 段落一：主要实验结论，列举 2-3 个核心发现，每个都有具体数值支撑
- 段落二：工作的创新点或贡献，以及后续研究展望（1-2 句）
- 禁止写"本研究具有重要价值"等空话，每句话必须有具体数值或事实依据
示例段落一："本研究系统验证了浆料固含量对硅基负极电化学性能的影响规律。低固含量样品（30 mg/mL）在1C倍率下500次循环后容量保持率高达[[89%]]，而高固含量样品（100 mg/mL）仅为61%，差距显著。XRD与SEM表征证实，高固含量导致颗粒团聚至5 μm以上，是性能下降的根本原因。"
示例段落二："本工作明确了硅基负极浆料加工的关键参数窗口（固含量≤60 mg/mL），为规模化制备提供了工艺依据。后续研究可进一步探索表面包覆改性与固含量协同优化策略，以实现[[性能与成本]]的双重提升。"

其他所有 content 页（文献综述、理论分析、讨论页，standard/split版式）：
- paragraphs 写 1-2 个完整段落（各 80-120 字）
- 从论文对应章节提取原文数据，改写为流畅叙述，体现因果逻辑
- 禁止只有标题和空白，禁止简单罗列名词

【可用的幻灯片类型（9种）】

1. cover
⚠️ author 字段必须从论文正文中仔细提取，按以下优先顺序查找：
- 作者姓名：① 标题页/封面的作者署名 → ② 摘要前的作者列表 → ③ 页眉/页脚署名 → ④ 致谢末尾"XXX撰写于……"
- 导师姓名：① 致谢中"感谢XXX教授/老师/导师的悉心指导/帮助" → ② 作者单位/机构标注 → ③ 通讯作者（"*"或"corresponding author"）
- 职称：从论文中提取原文（教授/副教授/研究员/讲师等），提取不到则不写职称
- 专业/学院（subtitle字段）：从论文封面、页眉或机构名称原文提取，不得自行编造
- ⛔ 如果确实找不到某项信息，留空字符串 ""，绝对不要写"XXX"、"某某"、"[姓名]"等占位符
{ "type": "cover", "title": "论文完整标题（从论文原文提取，不改写）", "subtitle": "学院/专业名称（从论文原文提取，找不到则留空字符串）", "author": "汇报人：[第一作者真实姓名，找不到留空]\\n指导教师：[导师真实姓名及职称，找不到留空]", "date": "${today}" }

2. contents
{ "type": "contents", "items": ["一、研究背景", "二、研究方法", "三、实验结果", "四、结论"] }

3. section（章节过渡页）
{ "type": "section", "number": "01", "title": "章节标题" }

4. content（内容页，standard/split版式使用1-2个完整段落，每段80-150字，体现因果逻辑）
{ "type": "content", "layout": "standard", "title": "硅基负极材料的挑战", "paragraphs": ["硅作为锂离子电池负极材料，理论比容量高达4200 mAh/g，约为商用石墨（372 mAh/g）的[[11倍]]以上，具有巨大的能量密度提升潜力。然而，硅在充放电过程中体积膨胀达[[300%]]，导致颗粒持续粉化、SEI膜反复破裂再生，持续消耗电解液，循环寿命急剧下降，200次后容量保持率普遍低于60%。", "现有解决方案（纳米化、碳包覆、硅碳复合）虽有改善，但制备成本是商用石墨的5-10倍，工艺复杂、难以规模化量产，这一核心矛盾严重制约了硅基负极的商业化进程。因此，开发兼顾性能与成本的加工工艺是当前研究的关键突破口。"], "notes": "重点讲硅的容量优势和体积膨胀这个核心矛盾，再点出为什么现有方案不够好" }

⚠️ 对比好坏示例：
❌ 错误（bullet point格式放进paragraphs）：["• 体积膨胀高达300%", "• SEI膜破裂", "• 成本高"] ← paragraphs不允许用•开头的条目
❌ 错误（段落空洞，无数据无因果）："硅基负极材料存在一些问题，影响了电池性能，需要进一步研究。" ← 没有任何信息量
✅ 正确（完整段落，含数据+现象+因果）："硅在充放电过程中体积膨胀达[[300%]]，导致颗粒粉化、SEI膜反复破裂，循环200次后容量保持率普遍低于60%。现有纳米化工艺虽有改善，但制备成本是石墨的5-10倍，规模化瓶颈依然突出。"

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
  - 写法：paragraphs[0] 是大字显示的核心陈述（1句话，20-40字，必须含具体数值，无"•"前缀），paragraphs[1] 可选补充说明（1-2句，解释意义或对比基准）
  - 典型标题例：「核心发现」「关键性能指标」「本文最重要的结论」

▸ "split"（必须出现 2-3 次）
  - 用于：有明确研究发现或实验结论的页面
  - 判断：这页是在陈述"我们发现了什么/证明了什么"，而不是在叙述"我们做了什么步骤"
  - 写法：paragraphs 写 1-2 个完整段落（各 80-120 字），段落中体现"发现了什么+数据支撑+机理解释"
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

【imageHint 字段规则（card 版式专用，每张卡片可选）】
- imageHint 是一句简短的中文描述（15字以内），说明该卡片"建议配什么图"，如："SEM颗粒形貌图"、"循环性能曲线"、"材料制备流程示意图"
- 仅在"这个卡片若有配图会大幅提升理解"时才添加 imageHint，不要每个卡片都强制加
- 适合加 imageHint 的场景：SEM/TEM/XRD 等实验图片、关键数据曲线图、结构/装置示意图、实验装置照片
- 不适合加 imageHint 的场景：纯数据对比/文字叙述（没有天然对应的图片）
- 有 imageHint 的卡片，points 只需写 1-2 条最核心的要点（图片占据卡片下半部分，文字区缩短）
- 同一张 card 幻灯片，可以部分卡片有 imageHint，部分没有

card 版式（含图片占位框示例）：
{ "type": "content", "layout": "card", "title": "微观结构表征", "paragraphs": [], "cards": [
  { "heading": "SEM 形貌", "points": ["• 颗粒呈球形，D50粒径 [[150 nm]]，分布均匀"], "imageHint": "SEM颗粒形貌图" },
  { "heading": "XRD 物相", "points": ["• 2θ=26.4°衍射峰对应石墨层间距，结晶度良好"], "imageHint": "XRD衍射图谱" },
  { "heading": "BET 比表面", "points": ["• 比表面积 [[142 m²/g]]，有效提升电解液接触面积", "• 孔径分布以介孔为主（2-50 nm）"] }
], "flow": false, "notes": "前两张卡片配实验图片，第三张纯文字数据" }

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
        model: "deepseek-v4-pro",
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
