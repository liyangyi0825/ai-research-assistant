// 所有 AI 请求统一路由到 DeepSeek Anthropic 兼容端点
// 不依赖任何环境变量，防止 Vercel 配置问题导致请求打到 Anthropic
const DEEPSEEK_BASE = "https://api.deepseek.com/anthropic";

export async function fetchWithProxy(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  if (url.startsWith("https://api.anthropic.com")) {
    url = url.replace("https://api.anthropic.com", DEEPSEEK_BASE);
    console.log("[fetch-proxy] → DeepSeek:", url);
  }
  return fetch(url, options);
}
