import type { NextConfig } from "next";
import fs from "fs";
import path from "path";

// 手动加载 .env.local（解决 Turbopack 不能自动读取的问题）
const envLocalPath = path.join(process.cwd(), ".env.local");
try {
  const content = fs.readFileSync(envLocalPath, "utf8");
  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  });
} catch {
  // .env.local 不存在时忽略
}

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // 允许最大 20MB 的请求体（用于 PDF 上传）
      // 注意：部署到 Vercel 免费版时平台硬限仍为 4.5MB，迁移到自有服务器后此配置生效
      bodySizeLimit: "20mb",
    },
  },
};

export default nextConfig;
