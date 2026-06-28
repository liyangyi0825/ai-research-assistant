// POST /api/generate-chart
// 接收图表配置，调用 Python matplotlib 生成高质量图片，返回访问 URL

import { NextRequest } from "next/server";
import { execFile } from "child_process";
import path from "path";
import fs from "fs";

const PYTHON = "/home/ubuntu/chart-env/bin/python3";
const SCRIPT = path.join(process.cwd(), "scripts", "generate_chart.py");
const CHARTS_DIR = path.join(process.cwd(), "public", "charts");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      data: Record<string, string | number>[];
      chart_type: "line" | "bar" | "scatter";
      x_col: string;
      y_cols: string[];
      title?: string;
      x_label?: string;
      y_label?: string;
    };

    if (!body.data?.length || !body.x_col || !body.y_cols?.length) {
      return Response.json({ error: "参数不完整" }, { status: 400 });
    }

    // 确保 public/charts 目录存在
    fs.mkdirSync(CHARTS_DIR, { recursive: true });

    const timestamp = Date.now();
    const outputPath = path.join(CHARTS_DIR, `chart_${timestamp}`);

    const config = JSON.stringify({
      ...body,
      output_path: outputPath,
    });

    const result = await new Promise<{ png: string; svg: string }>((resolve, reject) => {
      execFile(PYTHON, [SCRIPT, config], { timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) {
          console.error("[generate-chart] Python error:", stderr);
          reject(new Error(stderr || err.message));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed);
        } catch {
          console.error("[generate-chart] stdout parse error:", stdout);
          reject(new Error("Python 输出解析失败"));
        }
      });
    });

    // 把绝对路径转为公开 URL（/charts/xxx.png）
    const pngUrl = "/charts/" + path.basename(result.png);
    const svgUrl = "/charts/" + path.basename(result.svg);

    return Response.json({ pngUrl, svgUrl });
  } catch (error) {
    console.error("[generate-chart]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "图表生成失败，请重试" },
      { status: 500 }
    );
  }
}
