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

内容要求（最重要）：
- 每个部分必须提取论文中的**具体信息**：真实的方法名称、数据集名称、实验指标、百分比数字、对比基线等
- 不要写空洞的描述（如"作者提出了一种新方法"），要写出方法的具体名字和做法
- 如果论文有实验数据，必须在【主要结论】中列出关键数字

格式要求：
- 严格按照【研究问题】【研究方法】【主要结论】【创新点】四个标题输出
- 关键术语、方法名、核心数字用 **加粗** 标出（每段 2-3 处）
- 有多个并列要点时用列表（- 开头），单一内容直接写段落

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

