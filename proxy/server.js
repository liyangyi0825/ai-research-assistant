// Anthropic API 反向代理服务器
// 部署在 Render.com（美国服务器，可正常访问 Anthropic）
// 腾讯云服务器通过这个代理中转所有 Claude API 请求

const https = require("https");
const http = require("http");

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  // 健康检查
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  // /v1/messages → api.anthropic.com/v1/messages
  const path = req.url;

  const options = {
    hostname: "api.anthropic.com",
    port: 443,
    path: path,
    method: "POST",
    headers: {
      ...req.headers,
      host: "api.anthropic.com",
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("代理请求失败:", err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Bad Gateway");
    }
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, () => {
  console.log(`Anthropic 代理服务器运行在端口 ${PORT}`);
});
