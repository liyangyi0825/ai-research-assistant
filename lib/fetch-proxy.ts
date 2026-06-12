// 代理工具函数
// 开发环境：让 Node.js 请求走本地代理（7897端口），才能访问 Anthropic API
// 生产环境（中国服务器）：Anthropic API 被屏蔽，需要通过 Cloudflare Workers 中转
//   设置环境变量 ANTHROPIC_API_BASE_URL=https://your-worker.workers.dev
//   fetchWithProxy 会自动把 api.anthropic.com 替换成该地址

const PROXY_PORT = "7897";

const PROXY_URLS = [
  `http://127.0.0.1:${PROXY_PORT}`,
  `socks5://127.0.0.1:${PROXY_PORT}`,
];

/**
 * 带代理的 fetch
 * - 开发环境：走本地代理（科学上网）
 * - 生产环境：对 Anthropic API 调用，自动替换为 ANTHROPIC_API_BASE_URL（Cloudflare Workers）
 */
export async function fetchWithProxy(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  if (process.env.NODE_ENV !== "development") {
    // 生产环境：若配置了 Cloudflare Workers 代理，把 Anthropic API 地址替换掉
    const anthropicProxy = process.env.ANTHROPIC_API_BASE_URL;
    if (anthropicProxy && url.startsWith("https://api.anthropic.com")) {
      const proxyBase = anthropicProxy.replace(/\/$/, "");
      url = url.replace("https://api.anthropic.com", proxyBase);
    }
    return fetch(url, options);
  }

  // 开发环境：走本地代理
  const { ProxyAgent } = await import("undici");

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

  console.warn("所有代理均失败，尝试直连...");
  return fetch(url, options);
}
