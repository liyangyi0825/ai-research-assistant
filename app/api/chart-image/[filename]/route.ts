// GET /api/chart-image/[filename]
// 直接从磁盘读取图表文件并返回，绕过 Next.js 静态文件服务

import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;

  // 只允许 chart_时间戳.png 或 .svg 格式，防止路径穿越
  if (!/^chart_\d+\.(png|svg)$/.test(filename)) {
    return new Response("Not found", { status: 404 });
  }

  const filePath = path.join(process.cwd(), "public", "charts", filename);

  if (!fs.existsSync(filePath)) {
    console.log("[chart-image] file not found:", filePath);
    return new Response("Not found", { status: 404 });
  }

  const fileBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const contentType = ext === ".svg" ? "image/svg+xml" : "image/png";

  return new Response(fileBuffer, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
