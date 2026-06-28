import { NextResponse } from "next/server";
import { fetchWithProxy } from "@/lib/fetch-proxy";

export async function GET() {
  const apiKey = (process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    return NextResponse.json({ error: "API Key 未配置" });
  }

  // 显示 key 的前4位和后4位，用于核对是否是正确的 key
  const keyHint = `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;

  const res = await fetchWithProxy("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      max_tokens: 10,
      messages: [{ role: "user", content: "say hi" }],
    }),
  });

  const body = await res.text();
  return NextResponse.json({
    keyHint,
    status: res.status,
    response: body,
  });
}
