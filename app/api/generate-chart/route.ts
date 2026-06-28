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

    console.log('[chart] 收到请求:', { x_col: body.x_col, y_cols: body.y_cols, chart_type: body.chart_type });
    console.log('[chart] Python路径:', PYTHON);
    console.log('[chart] 脚本路径:', SCRIPT);

    if (!body.data?.length || !body.x_col || !body.y_cols?.length) {
      return Response.json({ error: "参数不完整" }, { status: 400 });
    }

    // 过滤掉数据里不存在的列名，防止 Python KeyError
    const actualCols = new Set(Object.keys(body.data[0]));
    const filteredYCols = body.y_cols.filter(c => actualCols.has(c));
    console.log('[chart] actualCols:', [...actualCols]);
    console.log('[chart] filteredYCols:', filteredYCols);
    if (filteredYCols.length === 0) {
      return Response.json(
        { error: `Y轴列名不存在，数据实际列名：${[...actualCols].join('、')}` },
        { status: 400 }
      );
    }
    body.y_cols = filteredYCols;

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
        console.log('[chart] stdout:', stdout);
        console.log('[chart] stderr:', stderr);
        console.log('[chart] error:', err);
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed);
        } catch {
          reject(new Error("Python 输出解析失败: " + stdout.slice(0, 200)));
        }
      });
    });

    // 通过 API Route 提供图片，绕过 Next.js 静态文件服务问题
    const pngUrl = "/api/chart-image/" + path.basename(result.png);
    const svgUrl = "/api/chart-image/" + path.basename(result.svg);
    console.log('[chart] 返回前端 URL:', { pngUrl, svgUrl });
    console.log('[chart] 文件实际路径:', { png: result.png, svg: result.svg });

    return Response.json({ pngUrl, svgUrl });
  } catch (error) {
    console.error("[generate-chart]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "图表生成失败，请重试" },
      { status: 500 }
    );
  }
}
