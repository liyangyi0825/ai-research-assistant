// 代理工具函数
// 开发环境：直连，不走本地代理（已切换到 DeepSeek，无需代理）
// 生产环境：若设置了 ANTHROPIC_API_BASE_URL，自动替换 Anthropic 端点地址
//   例如切换到 DeepSeek：ANTHROPIC_API_BASE_URL=https://api.deepseek.com/anthropic
//   或中转到 Cloudflare Workers：ANTHROPIC_API_BASE_URL=https://your-worker.workers.dev

// 保留变量，方便以后恢复代理时使用
// const PROXY_PORT = "7897";
// const PROXY_URLS = [
//   `http://127.0.0.1:${PROXY_PORT}`,
//   `socks5://127.0.0.1:${PROXY_PORT}`,
// ];

/**
 * 带代理的 fetch（当前：直连模式）
 * - 开发/生产：若配置了 ANTHROPIC_API_BASE_URL，自动替换 Anthropic 端点
 * - 否则直接 fetch，不经过任何本地代理
 */
// 默认指向 DeepSeek 兼容端点，可通过 ANTHROPIC_API_BASE_URL 覆盖
const DEEPSEEK_BASE = "https://api.deepseek.com/anthropic";

export async function fetchWithProxy(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  if (url.startsWith("https://api.anthropic.com")) {
    const base = (process.env.ANTHROPIC_API_BASE_URL ?? DEEPSEEK_BASE).replace(/\/$/, "");
    url = url.replace("https://api.anthropic.com", base);
  }

  return fetch(url, options);
}
