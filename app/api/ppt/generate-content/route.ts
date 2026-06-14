// POST /api/ppt/generate-content
// 输入：{ paperContent: string, scene: "defense" | "meeting" }
// 输出：{ slides: Slide[] } 结构化 JSON，供前端预览和后续生成 PPTX 文件使用

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

export type PptScene = "defense" | "meeting";

export interface CoverSlide   { type: "cover";    title: string; subtitle: string; author: string; date: string; }
export interface ContentsSlide{ type: "contents"; items: string[]; }
export interface SectionSlide { type: "section";  number: string; title: string; }
export interface ContentSlide { type: "content";  title: string; points: string[]; notes: string; }
export interface EndingSlide  { type: "ending"; }

export type Slide = CoverSlide | ContentsSlide | SectionSlide | ContentSlide | EndingSlide;

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

    const prompt = `你是一位专业的学术PPT设计专家。请将以下论文内容转化为PPT幻灯片的结构化大纲。

【场景】${isDefense ? "毕业/学位答辩（正式学术风格，通常15-20页）" : "组会/进展汇报（简洁风格，通常8-12页）"}

【输出规则】
1. 只输出纯 JSON，不要代码块（不要 \`\`\`），不要任何解释
2. 根据论文篇幅自行决定页数，不要固定
3. 每页 points（要点）不超过 5 条，每条不超过 20 字
4. 语言简洁、口语化，适合口头汇报
5. 保留关键数据和核心结论
${isDefense
  ? "6. 答辩重点：研究背景与意义、研究方法、创新点、主要结论与展望"
  : "6. 组会重点：研究进展、当前实验结果/数据、遇到的问题、下一步计划"
}
${isDefense
  ? "7. 答辩结构：封面→目录→章节过渡页→内容页→结尾页"
  : "7. 组会结构：封面→目录（可选）→内容页（无章节过渡页，更紧凑）→结尾页"
}

【JSON格式】严格按照以下结构，slide 类型见下方说明：

{
  "title": "论文标题",
  "scene": "${isDefense ? "答辩" : "组会"}",
  "total_pages": 15,
  "slides": [
    { "type": "cover", "title": "论文标题", "subtitle": "副标题或研究课题", "author": "汇报人", "date": "${today}" },
    { "type": "contents", "items": ["第一章 章节名", "第二章 章节名"] },
    { "type": "section", "number": "01", "title": "章节标题" },
    { "type": "content", "title": "页面标题", "points": ["要点1", "要点2", "要点3"], "notes": "演讲备注2-3句，帮助汇报人扩展这页内容" },
    { "type": "ending" }
  ]
}

【论文内容】
${paperContent.slice(0, 24000)}`;

    const claudeRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 6000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error("Claude PPT 内容生成错误:", err);
      return NextResponse.json({ error: "AI 生成失败，请重试" }, { status: 500 });
    }

    const claudeData = await claudeRes.json();
    const rawText: string = claudeData.content?.[0]?.text ?? "";

    // 清除可能的 markdown 代码块
    const cleaned = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

    let pptContent: PptContent;
    try {
      pptContent = JSON.parse(cleaned);
    } catch {
      console.error("PPT JSON 解析失败，原始输出：", rawText.slice(0, 500));
      return NextResponse.json({ error: "AI 输出格式异常，请重试" }, { status: 500 });
    }

    // 记录用量
    if (userId) {
      insertUsageRecord({
        userId,
        actionType: "ppt_generate",
        tokensInput:  claudeData.usage?.input_tokens  ?? 0,
        tokensOutput: claudeData.usage?.output_tokens ?? 0,
      }).catch(() => {});
    }

    return NextResponse.json({ pptContent });
  } catch (error) {
    console.error("PPT 内容生成异常:", error);
    return NextResponse.json({ error: "请求失败，请重试" }, { status: 500 });
  }
}
