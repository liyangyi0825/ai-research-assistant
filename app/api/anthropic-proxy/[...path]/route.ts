// Anthropic API 反向代理
// 路径：/api/anthropic-proxy/v1/messages 等
// 用途：腾讯云中国服务器无法直连 api.anthropic.com，
//       通过这个 Vercel 部署的路由中转请求

import { NextRequest } from "next/server";

// 使用 Edge Runtime，原生支持流式响应，延迟更低
export const runtime = "edge";

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  // 去掉 /api/anthropic-proxy 前缀，保留后面的路径（如 /v1/messages）
  const path = url.pathname.replace(/^\/api\/anthropic-proxy/, "");
  const anthropicUrl = `https://api.deepseek.com/anthropic${path}`;

  // 转发请求头（只保留 Anthropic API 需要的）
  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (
      key === "content-type" ||
      key === "x-api-key" ||
      key === "anthropic-version" ||
      key === "anthropic-beta"
    ) {
      forwardHeaders.set(key, value);
    }
  }

  const response = await fetch(anthropicUrl, {
    method: "POST",
    headers: forwardHeaders,
    body: request.body,
  });

  // 直接透传响应（含流式 SSE）
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
