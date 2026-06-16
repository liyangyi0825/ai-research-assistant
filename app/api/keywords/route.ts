// 后端接口：根据研究课题生成中英双语检索词组合
// 路径：POST /api/keywords

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { getSupabaseAuthClient, insertUsageRecord, checkUsageLimit, insertSearchHistory } from "@/lib/supabase";

export interface KeywordCombination {
  keywordsEn: string;   // 英文版：用 AND 连接，适配 Google Scholar / Semantic Scholar / arXiv
  keywordsCn: string;   // 中文版：空格分隔，适配知网 / 万方
  description: string;  // 一句话中文说明
}

export async function POST(req: NextRequest) {
  let userId: string | null = null;

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "服务器未配置 API Key" }, { status: 500 });
    }

    // 验证用户已登录
    const supabase = await getSupabaseAuthClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }
    userId = user.id;

    // 检查本月用量是否超限
    const { allowed, used, limit } = await checkUsageLimit("keyword_gen");
    if (!allowed) {
      return NextResponse.json(
        { error: `本月关键词生成次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
        { status: 429 }
      );
    }

    const { topic } = await req.json();
    if (!topic || !topic.trim()) {
      return NextResponse.json({ error: "请输入研究课题" }, { status: 400 });
    }

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1800,
        temperature: 0.3,
        messages: [
          {
            role: "user",
            content: `你是学术检索专家。用户的研究课题是：「${topic.trim()}」

请生成 8-10 个检索词组合，每个组合同时提供中英文两个版本，全面覆盖这个课题的各个研究方向。

英文版（keywordsEn）要求：
- 2-4 个关键词，用 AND 连接（适配 Google Scholar）
- 使用学术圈真实使用的英文专业术语

中文版（keywordsCn）要求：
- 2-4 个关键词，用空格分隔（适配知网，不需要 AND）
- 使用中国学术圈真正使用的地道中文术语，不要生硬直译
  ✅ 正确示例：界面工程 钙钛矿太阳能电池 转换效率
  ❌ 错误示例：界面工程学 钙钛矿型太阳能 效率提升
- 用户输入中文时直接沿用原有中文术语；用户输入英文时做高质量学术翻译

覆盖角度：① 核心方法 ② 具体应用/任务 ③ 对比基线/前人工作 ④ 数据集/评测（如适用）

description：一句话中文，说明该组合检索的方向

只输出纯 JSON，不要代码块，不要任何解释：
{"combinations":[{"keywordsEn":"term1 AND term2","keywordsCn":"术语1 术语2","description":"中文说明"}]}`,
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("Claude API 错误:", err);
      return NextResponse.json({ error: "关键词生成失败" }, { status: 500 });
    }

    const data = await anthropicRes.json();
    const text: string = data.content?.[0]?.text ?? "";

    // 清除可能的 markdown 代码块
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    // 写入 usage 记录
    if (userId) {
      const inputTokens = data.usage?.input_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;

      console.log('开始写入usage', {userId, actionType: 'keyword_gen', inputTokens, outputTokens});

      try {
        await insertUsageRecord({
          userId,
          actionType: "keyword_gen",
          tokensInput: inputTokens,
          tokensOutput: outputTokens,
        });
        console.log('写入结果', 'success');
      } catch (error) {
        // 用量记录失败不影响主流程
        console.error('写入错误', error);
      }
    } else {
      console.error('写入错误', 'userId为空');
    }

    // 保存搜索历史（不影响主流程）
    if (userId) insertSearchHistory({ userId, type: "keyword_gen", query: topic.trim() });

    return NextResponse.json({
      combinations: parsed.combinations as KeywordCombination[],
    });
  } catch (error) {
    console.error("关键词生成异常:", error);
    return NextResponse.json({ error: "生成失败，请重试" }, { status: 500 });
  }
}
