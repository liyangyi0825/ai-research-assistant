// 腾讯云 OCR 接口：把单页 PDF 的 canvas 截图识别为文字
// 只在 status === "empty"（unpdf 提取不到文字）的页面才会调用
import { NextRequest, NextResponse } from "next/server";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ocr } = require("tencentcloud-sdk-nodejs-ocr");
const OcrClient = ocr.v20181119.Client;

interface TencentTextBlock {
  DetectedText: string;
  ItemPolygon: { X: number; Y: number; Width: number; Height: number };
}

export async function POST(req: NextRequest) {
  try {
    const secretId  = process.env.TENCENT_SECRET_ID;
    const secretKey = process.env.TENCENT_SECRET_KEY;
    if (!secretId || !secretKey) {
      return NextResponse.json({ error: "未配置腾讯云 OCR 密钥" }, { status: 500 });
    }

    const { imageBase64 } = await req.json() as { imageBase64?: string };
    if (!imageBase64) {
      return NextResponse.json({ error: "未提供图片数据" }, { status: 400 });
    }

    // 去掉浏览器 canvas.toDataURL() 产生的 data URI 前缀
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

    const client = new OcrClient({
      credential: { secretId, secretKey },
      region: process.env.TENCENT_OCR_REGION ?? "ap-beijing",
      profile: { httpProfile: { endpoint: "ocr.tencentcloudapi.com" } },
    });

    const response = await client.GeneralBasicOCR({ ImageBase64: base64Data }) as {
      TextDetections?: TencentTextBlock[];
    };

    const detections: TencentTextBlock[] = response.TextDetections ?? [];
    if (detections.length === 0) {
      return NextResponse.json({ text: "" });
    }

    // 按 Y 坐标排序（从上到下）
    detections.sort((a, b) => a.ItemPolygon.Y - b.ItemPolygon.Y);

    // 把同一行的文字块归组（Y 差 < 行高 × 0.6 视为同行），再按 X 排
    const lineGroups: string[][] = [];
    let currentGroup: Array<{ text: string; x: number }> = [];
    let lineTopY = -1;

    for (const det of detections) {
      const { X: x, Y: y, Height: h } = det.ItemPolygon;
      if (lineTopY < 0 || (y - lineTopY) > (h || 20) * 0.6) {
        if (currentGroup.length > 0) {
          lineGroups.push(
            currentGroup.sort((a, b) => a.x - b.x).map(g => g.text)
          );
        }
        currentGroup = [{ text: det.DetectedText, x }];
        lineTopY = y;
      } else {
        currentGroup.push({ text: det.DetectedText, x });
      }
    }
    if (currentGroup.length > 0) {
      lineGroups.push(
        currentGroup.sort((a, b) => a.x - b.x).map(g => g.text)
      );
    }

    const text = lineGroups.map(line => line.join(" ")).join("\n");
    return NextResponse.json({ text });

  } catch (error) {
    const msg = error instanceof Error ? error.message : "OCR 识别失败，请重试";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
