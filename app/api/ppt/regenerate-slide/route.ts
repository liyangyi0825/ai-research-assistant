// POST /api/ppt/regenerate-slide
// 单页重新生成：根据用户指令修改指定幻灯片内容
import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import type { Slide } from "@/app/api/ppt/generate-content/route";

/**
 * 补全被截断的 JSON 字符串（括号计数法）。
 * 能处理截断发生在字符串内部的情况（如 "paragrap 被截断）。
 */
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

    const { currentSlide, prevSlide, nextSlide, userInstruction, scene } = (await req.json()) as {
      currentSlide: Slide;
      prevSlide: Slide | null;
      nextSlide: Slide | null;
      userInstruction: string;
      scene: "defense" | "meeting";
    };

    if (!userInstruction?.trim()) {
      return NextResponse.json({ error: "请输入修改指令" }, { status: 400 });
    }

    const isDefense = scene === "defense";

    const prompt = `你是一位专业的学术PPT设计专家。请根据用户指令修改指定的幻灯片，只输出单个 slide 的 JSON 对象，以 { 开头以 } 结尾，不要任何说明文字，不要代码块标记。

【场景】${isDefense ? "毕业/学位答辩（正式学术风格）" : "组会/进展汇报（简洁风格）"}

【用户修改指令】
${userInstruction}

【当前页内容（需要修改的页面）】
${JSON.stringify(currentSlide, null, 2)}

${prevSlide ? `【上一页内容（参考，保持逻辑连贯）】\n${JSON.stringify(prevSlide, null, 2)}\n` : ""}
${nextSlide ? `【下一页内容（参考，保持逻辑连贯）】\n${JSON.stringify(nextSlide, null, 2)}\n` : ""}

【内容格式规则——必须严格遵守】

★ paragraphs 字段（standard / split 版式）：
  - 1-2 个完整段落字符串，每段 3-5 句话，每段不少于 80 字
  - 段落是流畅陈述性文字，不加"•"符号，不分条罗列
  - ⛔ 所有字符串字段内绝对不能出现英文直引号 " 或反斜杠 \，需要引用/强调术语时改用「」，否则会破坏 JSON 格式导致解析失败
  - 每段包含：核心观点 + 支撑数据 + 因果说明，三者缺一不可
  - ⛔ 禁止 bullet point 格式（"• 某某"）出现在 paragraphs 里

★ 关键词高亮：在段落里用 [[双方括号]] 标记最关键的 1-2 个词/数值（自动渲染为红色加粗）
  - ✅ "硅体积膨胀高达 [[300%]]，导致颗粒粉化"
  - ⛔ 每段最多 2-3 处，禁止连续多处高亮
  - ⛔ [[]] 不用于 title、notes、heading 字段

★ layout 选择规则（content 类型）：
  - "hero"：全文最关键单一数据/结论，大字突出（paragraphs[0] 含数值，20-40字）
  - "split"：陈述研究发现/实验结论（左标题，右段落）
  - "card"：内容分 2-3 个并列子主题（使用 cards 数组，points 简短条目）
  - "standard"：背景/文献综述/叙述性内容

★ card 版式：cards 数组，每项含 heading（5-12字）和 points（2-4条，以 • 开头，简洁含数据）
  - flow:true = 有先后顺序（加 ①②③），flow:false = 并列关系

★ figure 类型：figure_desc（图表描述，2-3句）和 analysis（机理分析，2-3句）都要详细
  - chart_data（可选）：当前页原本有 chart_data 时，修改内容需保留/同步更新其中数值，⛔ 不要凭空编造新数字；原本没有就不要新增

★ notes 字段：口语说明"承接上页什么内容"和"引出下页什么内容"

【可用的幻灯片类型】
cover / contents / section / content / figure / stats / table / comparison / ending

content 类型字段：type, layout, title, paragraphs, cards(可选), flow(可选), notes
figure 类型字段：type, title, figure_desc, analysis, notes, chart_data(可选)
stats 类型字段：type, title, stats(value/unit/label/color数组), notes
table 类型字段：type, title, headers, rows, notes
comparison 类型字段：type, title, columns(heading/color/points数组), notes

【输出要求】
- 只输出单个幻灯片的 JSON 对象（不是数组）
- 必须包含 "type" 字段
- 根据用户指令修改内容或版式
- 参考上下页保持逻辑连贯
- 不要在 JSON 外面加任何文字`;

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
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `AI 生成失败（${res.status}）：${err.slice(0, 120)}` }, { status: 500 });
    }

    const data = await res.json();
    const rawText: string = data?.content?.[0]?.text ?? "";

    const stripped = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const jsonStart = stripped.indexOf("{");
    const jsonEnd   = stripped.lastIndexOf("}");
    const cleaned   = jsonStart !== -1 && jsonEnd > jsonStart
      ? stripped.slice(jsonStart, jsonEnd + 1)
      : stripped;

    let slide: Slide;
    try {
      slide = JSON.parse(cleaned);
    } catch {
      // 截断容错：括号计数法补全后再解析
      console.error("单页重生成 JSON 首次解析失败：", rawText.slice(0, 500));
      try {
        slide = JSON.parse(closeTruncatedJSON(cleaned));
        console.log("单页重生成 JSON 截断补全成功");
      } catch {
        return NextResponse.json({ error: "AI 输出格式异常，请重试" }, { status: 500 });
      }
    }

    return NextResponse.json({ slide });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `请求失败：${msg.slice(0, 120)}` }, { status: 500 });
  }
}
