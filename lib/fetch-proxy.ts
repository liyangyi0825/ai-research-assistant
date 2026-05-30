// 代理工具函数
// 开发环境中让 Node.js 请求走本地代理，才能访问 Anthropic API
// 部署到 Vercel 后自动不走代理（生产环境不需要）

const PROXY_PORT = "7897";

// 同时准备 HTTP 和 SOCKS5 两种格式，自动选择能用的那个
const PROXY_URLS = [
  `http://127.0.0.1:${PROXY_PORT}`,
  `socks5://127.0.0.1:${PROXY_PORT}`,
];

/**
 * 带代理的 fetch（开发环境自动走代理，生产环境正常 fetch）
 */
export async function fetchWithProxy(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  if (process.env.NODE_ENV !== "development") {
    return fetch(url, options);
  }

  const { ProxyAgent } = await import("undici");

  // 先试 HTTP 代理，再试 SOCKS5
  for (const proxyUrl of PROXY_URLS) {
    try {
      const dispatcher = new ProxyAgent(proxyUrl);
      // @ts-ignore - dispatcher 是 Node.js 专有参数
      const res = await fetch(url, { ...options, dispatcher });
      return res;
    } catch (err) {
      console.log(`代理 ${proxyUrl} 失败，尝试下一个...`, (err as Error).message);
    }
  }

  // 两种代理都失败，直接请求（可能失败）
  console.warn("所有代理均失败，尝试直连...");
  return fetch(url, options);
}
