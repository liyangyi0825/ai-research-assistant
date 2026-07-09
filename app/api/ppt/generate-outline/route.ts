// POST /api/ppt/generate-outline
// 输入：{ paperContent: string, scene: "defense" | "meeting" }
// 输出：{ outline: SlideOutlineItem[] } —— 只生成PPT的骨架结构（类型+标题），不含正文内容
import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import type { PptScene } from "@/app/api/ppt/generate-content/route";

export type SlideOutlineType =
  | "cover" | "contents" | "section" | "content" | "figure"
  | "stats" | "table" | "comparison" | "ending";

export interface SlideOutlineItem {
  type: SlideOutlineType;
  title: string;
  sectionNumber?: string; // 仅 type=section 使用，如 "01" "02"
  note?: string;          // 用户在编辑阶段添加的备注，AI 不生成此字段
}

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
  // 截断处可能恰好停在逗号后（如 "...},{"type":"section",...},"），需先去掉末尾多余的逗号再补括号
  result = result.replace(/,\s*$/, "");
  for (let i = 0; i < brackets; i++) result += "]";
  for (let i = 0; i < braces; i++) result += "}";
  return result;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });

    const { paperContent, scene } = (await req.json()) as {
      paperContent: string;
      scene: PptScene;
    };

    if (!paperContent?.trim()) return NextResponse.json({ error: "论文内容不能为空" }, { status: 400 });
    if (!["defense", "meeting"].includes(scene)) return NextResponse.json({ error: "场景参数错误" }, { status: 400 });

    const keyContent = paperContent.slice(0, 20000);
    const isDefense = scene === "defense";

    const prompt = `你是一位专业的学术PPT设计专家。请阅读下面的论文内容，只规划PPT的骨架结构（大纲），⛔ 不要生成任何正文内容、段落、数据分析。

【场景】${isDefense ? "毕业/学位答辩（正式学术风格）" : "组会/进展汇报（简洁风格）"}

【任务】
按论文实际章节顺序，规划每一页幻灯片的类型和标题，输出一个 JSON 数组。

【规则】
- 必须按照论文的实际章节结构排列，标题尽量使用论文原文的章节名或小标题
- 总页数（不含 figure 页）控制在 15-20 页之间
- figure 页专门标记：论文中有实验数据图表（如循环性能曲线、SEM图、XRD图等）的地方，标记为 type="figure"，不计入 15-20 页限制
- 每一页只有 type 和 title 两个字段（type="section" 时额外加 sectionNumber，如 "01" "02"）
- ⛔ 不要输出 paragraphs、notes、cards、chart_data 等正文字段
- 可用 type：cover / contents / section / content / figure / stats / table / comparison / ending
- 结构参考：${isDefense ? "封面→目录→章节过渡页(section)→内容页→结尾页" : "封面→目录→内容页→结尾页（省略 section 过渡页）"}

【输出要求——最高优先级】
只输出纯 JSON 数组，以 [ 开头以 ] 结尾，不要代码块标记，不要任何说明文字。

【JSON 格式示例】
[
  {"type":"cover","title":"论文标题"},
  {"type":"contents","title":"目录"},
  {"type":"section","title":"研究背景","sectionNumber":"01"},
  {"type":"content","title":"硅基负极材料的研究现状"},
  {"type":"figure","title":"图1：循环性能对比"},
  {"type":"ending","title":"谢谢观看"}
]

【论文内容】
${keyContent}`;

    const res = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 8192,
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

    let outline: SlideOutlineItem[];
    try {
      outline = JSON.parse(cleaned);
    } catch {
      console.error("大纲生成 JSON 首次解析失败，输出前500字：", rawText.slice(0, 500));
      try {
        outline = JSON.parse(closeTruncatedJSON(cleaned));
        console.log("大纲生成 JSON 截断补全成功");
      } catch (e2) {
        console.error("大纲生成 JSON 截断补全仍失败：", e2 instanceof Error ? e2.message : String(e2));
        return NextResponse.json({ error: "AI 输出格式异常，请重试" }, { status: 500 });
      }
    }

    if (!Array.isArray(outline) || outline.length === 0) {
      return NextResponse.json({ error: "AI 输出内容为空，请重试" }, { status: 500 });
    }

    return NextResponse.json({ outline });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `请求失败：${msg.slice(0, 120)}` }, { status: 500 });
  }
}
