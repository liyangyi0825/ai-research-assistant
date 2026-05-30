import { NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";

export async function GET() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "API Key 未配置" });
  }

  // 用最简单的模型发一条测试消息
  const res = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 10,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });

  const body = await res.text();
  return NextResponse.json({
    status: res.status,
    response: body,
  });
}
