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
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: `请仔细阅读以下学术论文，用中文生成一份结构化总结。严格按照下面的格式输出，不要添加其他内容：

【研究问题】
（这篇论文要解决什么问题？背景是什么？为什么重要？）

【研究方法】
（作者用了什么方法、实验设计、数据集或理论框架？）

【主要结论】
（论文得出了哪些主要发现和结论？有数据支撑则请列出关键数字。）

【创新点】
（相比已有研究，这篇论文有哪些新贡献或创新之处？）

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
