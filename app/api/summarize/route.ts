// 后端接口：接收论文文字，调用 Claude API 生成结构化总结
// 路径：POST /api/summarize
// ⚠️ API Key 在服务器端读取，绝不暴露给浏览器

import { NextRequest, NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "服务器未配置 API Key，请检查 .env.local 文件" },
        { status: 500 }
      );
    }

    const { content } = await req.json();

    if (!content || content.trim().length === 0) {
      return NextResponse.json({ error: "论文内容为空" }, { status: 400 });
    }

    const truncatedContent = content.slice(0, 80000);

    // 调用 Anthropic API（开发环境走本地代理）
    const anthropicRes = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: `请仔细阅读以下学术论文，用中文生成一份结构化总结。

格式要求：
1. 严格按照【研究问题】【研究方法】【主要结论】【创新点】四个标题输出，不要添加其他内容
2. 使用 Markdown 格式标记重点：
   - 关键术语、核心发现、重要数字用 **加粗** 标出（每段最多 2-3 处，不要过度加粗）
   - 有多个并列要点时，用列表格式（每项以 - 开头）展示
   - 没有并列要点时，直接写段落即可
3. 语言简洁，每段控制在 100 字以内

输出格式示例：
【研究问题】
本文针对**某领域核心问题**展开研究，背景是...

【研究方法】
作者采用了**方法名称**，主要包括：
- 步骤或模块一
- 步骤或模块二

【主要结论】
实验结果表明**关键指标提升了 X%**，具体发现：
- 结论一
- 结论二

【创新点】
- 首次提出了**创新方法名**
- 在**特定场景**下取得了超越基线的效果

论文内容如下：
---
${truncatedContent}
---`,
          },
        ],
      }),
    });

    // 把 Anthropic 返回的完整错误信息打印出来
    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error(`Anthropic API 错误 ${anthropicRes.status}:`, errBody);
      return NextResponse.json(
        { error: `API错误 ${anthropicRes.status}: ${errBody}` },
        { status: 500 }
      );
    }

    const data = await anthropicRes.json();
    const summary = data.content?.[0]?.text ?? "";

    return NextResponse.json({ summary });
  } catch (error) {
    console.error("请求失败:", error);
    const msg = error instanceof Error ? error.message : "请求失败，请重试";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

