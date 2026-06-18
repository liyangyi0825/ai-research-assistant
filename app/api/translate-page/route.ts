// 按页翻译接口：每次翻译 PDF 的一页
// 只在第一页（isFirst=true）检查并记录用量，整篇 PDF 只消耗一次配额
import { NextRequest } from "next/server";
import { after } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";
import { checkUsageLimit, insertUsageRecord } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "服务器未配置 API Key" }, { status: 500 });
    }

    const { pageNum, text, isFirst } = (await req.json()) as {
      pageNum: number;
      text: string;
      isFirst: boolean;
    };

    // 只在第一页检查用量，整篇 PDF 只扣一次配额
    let userId: string | null = null;
    if (isFirst) {
      const { allowed, used, limit, userId: uid } = await checkUsageLimit("translate");
      if (!allowed) {
        return Response.json(
          { error: `本月全文翻译次数已用完（${used}/${limit} 次），下月 1 日自动重置` },
          { status: 429 },
        );
      }
      userId = uid;
    }

    // 页面无文字（如纯图片页）直接返回空流
    if (!text?.trim()) {
      return new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    const prompt = `请将以下论文第 ${pageNum} 页的内容翻译成中文。

基本要求：
- 保留段落结构，每个自然段对应输出一段
- 专业术语格式：中文（English原文），例如"界面钝化（interface passivation）"
- 参考文献条目不翻译，直接输出英文原文
- 人名、机构名、期刊名保留英文
- 直接输出译文，不要加任何解释或注释

图表说明文字处理规则：
- "Figure X: ..." → 译为"图X："，并以 Markdown 引用块格式单独输出（行首加 > ）
- "Table X: ..." → 译为"表X："，并以 Markdown 引用块格式单独输出（行首加 > ）
- "Fig. X ..." → 译为"图X "，并以 Markdown 引用块格式单独输出（行首加 > ）
- 图表说明的其余文字正常翻译成中文
- 示例：
    原文：Figure 1: Comparison of battery performance across different cycles
    译文：> 图1：不同循环次数下的电池性能对比
- 图表内部的坐标轴标签、图例文字（如 Capacity (mAh/g)）：保留英文，括号内附中文，如 Capacity (mAh/g，容量)

数学公式处理规则（重要）：
- 遇到 LaTeX 公式（如 $E=mc^2$ 或 $$\\int_0^\\infty$$）：保留原始 LaTeX 不翻译，原样输出
- 遇到行间公式用 $$ ... $$ 包裹，行内公式用 $ ... $ 包裹
- 若 PDF 提取导致公式符号乱码（出现乱码字符），用文字描述代替，格式：[公式：描述公式含义]
- 不要翻译或改写公式中的数学符号（α β γ Σ ∫ 等），遇到孤立数学符号直接原样保留
- 不要把公式变成普通文字句子

以下是第 ${pageNum} 页的原文：

${text}`;

    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        temperature: 0.3,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      return Response.json(
        { error: `API 错误 ${anthropicRes.status}: ${errBody}` },
        { status: 500 },
      );
    }

    // 第一页成功后记录一次用量（整篇 PDF 只计一次）
    if (isFirst && userId) {
      after(async () => {
        await insertUsageRecord({
          userId: userId!,
          actionType: "translate",
          tokensInput: 0,
          tokensOutput: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        });
      });
    }

    // 直接透传 Anthropic SSE 流给前端
    return new Response(anthropicRes.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "请求失败，请重试";
    return Response.json({ error: msg }, { status: 500 });
  }
}
