// POST /api/ppt/generate-file
// 输入：{ pptContent: PptContent } — 由 /api/ppt/generate-content 产生的 JSON
// 输出：PPTX 二进制文件（application/octet-stream），不额外消耗 AI 配额
// 所有 pptxgenjs 颜色值均不带 #（库规定）

import { NextRequest, NextResponse } from "next/server";
import type PptxGenJS from "pptxgenjs";
import type {
  PptContent,
  Slide,
  CoverSlide,
  ContentsSlide,
  SectionSlide,
  ContentSlide,
  StatsSlide,
  TableSlide,
  ComparisonSlide,
} from "@/app/api/ppt/generate-content/route";

// ── 颜色常量 ─────────────────────────────────────────────────────────────────
const C = {
  NAVY:   "1B3A8C",
  NAVY_D: "0F2361",
  GOLD:   "C8A44A",
  WHITE:  "FFFFFF",
  LIGHT:  "F0F4FF",
  GRAY:   "E0E4EE",
  TEXT:   "1A1A2E",
  RED:    "8B1A1A",
  ORANGE: "B8600A",
  GREEN:  "1B6B3A",
  PURPLE: "5B1A7A",
};

const CARD_COLORS = [C.NAVY, C.RED, C.GREEN, C.ORANGE, C.PURPLE];

const W = 10;
const H = 5.625;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function opt(o: Record<string, unknown>): any {
  return JSON.parse(JSON.stringify(o));
}

// ── 辅助 ─────────────────────────────────────────────────────────────────────
function addBg(slide: PptxGenJS.Slide, color: string) {
  slide.addShape("rect", opt({ x: 0, y: 0, w: W, h: H, fill: { color } }));
}

// ── 各类型渲染 ────────────────────────────────────────────────────────────────

function renderCover(prs: PptxGenJS, s: CoverSlide) {
  const slide = prs.addSlide();
  slide.addShape("rect", opt({ x: 0, y: 0, w: W, h: H, fill: { color: C.NAVY_D } }));
  slide.addShape("rect", opt({ x: 7.5, y: 0, w: 2.5, h: H, fill: { color: C.NAVY }, line: { color: C.NAVY } }));
  slide.addShape("rect", opt({ x: 0.4, y: 1.2, w: 3.5, h: 0.06, fill: { color: C.GOLD } }));

  slide.addText(s.title, opt({
    x: 0.4, y: 1.4, w: 6.8, h: 1.4,
    fontSize: 30, bold: true, color: C.WHITE, fontFace: "微软雅黑",
    valign: "top", wrap: true,
  }));
  if (s.subtitle) {
    slide.addText(s.subtitle, opt({
      x: 0.4, y: 3.0, w: 6.5, h: 0.45,
      fontSize: 14, color: C.GOLD, fontFace: "微软雅黑",
    }));
  }
  const authorLines = (s.author || "").replace(/\\n/g, "\n");
  slide.addText(authorLines, opt({
    x: 0.4, y: 3.55, w: 6.5, h: 0.7,
    fontSize: 12, color: "AABBDD", fontFace: "微软雅黑",
  }));
  slide.addText(s.date || "", opt({
    x: 0.4, y: 4.3, w: 6.5, h: 0.4,
    fontSize: 11, color: "8899BB", fontFace: "微软雅黑",
  }));
  slide.addText("学\n术\n报\n告", opt({
    x: 8.0, y: 1.5, w: 1.2, h: 2.5,
    fontSize: 16, bold: true, color: "AABBDD", fontFace: "微软雅黑",
    align: "center", valign: "middle",
  }));
}

function renderContents(prs: PptxGenJS, s: ContentsSlide) {
  const slide = prs.addSlide();
  addBg(slide, C.WHITE);
  slide.addShape("rect", opt({ x: 0, y: 0, w: 0.12, h: H, fill: { color: C.NAVY } }));
  slide.addShape("rect", opt({ x: 0, y: 0, w: W, h: 1.0, fill: { color: C.NAVY } }));
  slide.addText("目 录", opt({
    x: 0.4, y: 0, w: 9.0, h: 1.0,
    fontSize: 24, bold: true, color: C.WHITE, fontFace: "微软雅黑", valign: "middle",
  }));

  const items = s.items || [];
  const cols = items.length > 6 ? 2 : 1;
  const half = Math.ceil(items.length / cols);

  items.forEach((item, i) => {
    const col  = Math.floor(i / half);
    const row  = i % half;
    const xBase = cols === 2 ? (col === 0 ? 0.5 : 5.3) : 0.8;
    const colW  = cols === 2 ? 4.5 : 8.8;
    const yBase = 1.25 + row * 0.62;

    slide.addShape("ellipse", opt({ x: xBase, y: yBase + 0.05, w: 0.36, h: 0.36, fill: { color: C.NAVY } }));
    slide.addText(`${i + 1}`, opt({
      x: xBase, y: yBase + 0.05, w: 0.36, h: 0.36,
      fontSize: 11, bold: true, color: C.WHITE, fontFace: "微软雅黑",
      align: "center", valign: "middle",
    }));
    slide.addText(item, opt({
      x: xBase + 0.46, y: yBase, w: colW - 0.5, h: 0.46,
      fontSize: 14, color: C.TEXT, fontFace: "微软雅黑", valign: "middle",
    }));
    if (row < half - 1) {
      slide.addShape("rect", opt({ x: xBase, y: yBase + 0.5, w: colW - 0.1, h: 0.01, fill: { color: C.GRAY } }));
    }
  });
}

function renderSection(prs: PptxGenJS, s: SectionSlide) {
  const slide = prs.addSlide();
  slide.addShape("rect", opt({ x: 0, y: 0, w: W, h: H, fill: { color: C.NAVY } }));
  slide.addShape("rect", opt({ x: 6.5, y: -0.5, w: 4.0, h: 4.0, fill: { color: C.NAVY_D }, line: { color: C.NAVY_D } }));
  slide.addShape("rect", opt({ x: 7.0, y: 2.0, w: 3.5, h: 4.0, fill: { color: "162E70" }, line: { color: "162E70" } }));

  slide.addText(s.number || "01", opt({
    x: 0.6, y: 1.0, w: 3.0, h: 1.4,
    fontSize: 80, bold: true, color: "2A4DA8", fontFace: "Arial Black", valign: "middle",
  }));
  slide.addShape("rect", opt({ x: 0.6, y: 2.9, w: 2.0, h: 0.07, fill: { color: C.GOLD } }));
  slide.addText(s.title, opt({
    x: 0.6, y: 3.1, w: 6.2, h: 1.1,
    fontSize: 28, bold: true, color: C.WHITE, fontFace: "微软雅黑", valign: "top", wrap: true,
  }));
}

function renderContent(prs: PptxGenJS, s: ContentSlide) {
  const slide = prs.addSlide();
  addBg(slide, C.WHITE);
  slide.addShape("rect", opt({ x: 0, y: 0, w: W, h: 1.0, fill: { color: C.NAVY } }));
  slide.addShape("rect", opt({ x: 0, y: 0, w: 0.12, h: H, fill: { color: C.GOLD } }));
  slide.addText(s.title || "", opt({
    x: 0.35, y: 0, w: 9.3, h: 1.0,
    fontSize: 20, bold: true, color: C.WHITE, fontFace: "微软雅黑", valign: "middle",
  }));

  const pts = (s.points || []).slice(0, 6);
  const n = pts.length;
  const startY = 1.15;
  const endY   = 5.15;
  const spacing = n > 1 ? (endY - startY) / (n - 1) : 0;

  pts.forEach((pt, i) => {
    const py = n === 1 ? (startY + endY) / 2 - 0.25 : startY + i * spacing - 0.15;
    slide.addShape("rect", opt({ x: 0.3, y: py, w: 0.32, h: 0.32, fill: { color: C.NAVY }, rectRadius: 0.04 }));
    slide.addText(`${i + 1}`, opt({
      x: 0.3, y: py, w: 0.32, h: 0.32,
      fontSize: 10, bold: true, color: C.WHITE, fontFace: "微软雅黑",
      align: "center", valign: "middle",
    }));
    slide.addText(pt, opt({
      x: 0.72, y: py - 0.03, w: 9.0, h: 0.5,
      fontSize: 14, color: C.TEXT, fontFace: "微软雅黑", valign: "middle", wrap: true,
    }));
    if (i < n - 1) {
      slide.addShape("rect", opt({ x: 0.3, y: py + 0.38, w: 9.3, h: 0.01, fill: { color: C.GRAY } }));
    }
  });
}

function renderStats(prs: PptxGenJS, s: StatsSlide) {
  const slide = prs.addSlide();
  addBg(slide, C.LIGHT);
  slide.addShape("rect", opt({ x: 0, y: 0, w: W, h: 1.0, fill: { color: C.NAVY } }));
  slide.addShape("rect", opt({ x: 0, y: 0, w: 0.12, h: H, fill: { color: C.GOLD } }));
  slide.addText(s.title || "", opt({
    x: 0.35, y: 0, w: 9.3, h: 1.0,
    fontSize: 20, bold: true, color: C.WHITE, fontFace: "微软雅黑", valign: "middle",
  }));

  const stats = (s.stats || []).slice(0, 4);
  const n = stats.length;
  const cardW = n >= 4 ? 2.1 : n === 3 ? 2.8 : n === 2 ? 4.0 : 6.0;
  const totalW = cardW * n + 0.25 * (n - 1);
  const startX = (W - totalW) / 2;

  stats.forEach((st, i) => {
    const cx    = startX + i * (cardW + 0.25);
    const cy    = 1.3;
    const cardH = 3.7;
    const color = st.color || CARD_COLORS[i % CARD_COLORS.length];

    slide.addShape("rect", opt({ x: cx, y: cy, w: cardW, h: cardH, fill: { color }, rectRadius: 0.1 }));

    slide.addText(st.value || "", opt({
      x: cx + 0.1, y: cy + 0.5, w: cardW - 0.2, h: 1.4,
      fontSize: n >= 4 ? 34 : 42, bold: true, color: C.WHITE, fontFace: "Arial Black",
      align: "center", valign: "middle",
    }));
    slide.addText(st.unit || "", opt({
      x: cx + 0.1, y: cy + 1.95, w: cardW - 0.2, h: 0.55,
      fontSize: 13, bold: true, color: "DDEEFF", fontFace: "微软雅黑",
      align: "center", valign: "middle",
    }));
    slide.addShape("rect", opt({ x: cx + 0.3, y: cy + 2.55, w: cardW - 0.6, h: 0.02, fill: { color: "FFFFFF" } }));
    slide.addText(st.label || "", opt({
      x: cx + 0.1, y: cy + 2.65, w: cardW - 0.2, h: 0.8,
      fontSize: 12, color: "CCDDEF", fontFace: "微软雅黑",
      align: "center", valign: "middle", wrap: true,
    }));
  });
}

function renderTable(prs: PptxGenJS, s: TableSlide) {
  const slide = prs.addSlide();
  addBg(slide, C.WHITE);
  slide.addShape("rect", opt({ x: 0, y: 0, w: W, h: 1.0, fill: { color: C.NAVY } }));
  slide.addShape("rect", opt({ x: 0, y: 0, w: 0.12, h: H, fill: { color: C.GOLD } }));
  slide.addText(s.title || "", opt({
    x: 0.35, y: 0, w: 9.3, h: 1.0,
    fontSize: 20, bold: true, color: C.WHITE, fontFace: "微软雅黑", valign: "middle",
  }));

  const headers = s.headers || [];
  const rows    = s.rows    || [];
  const colN    = headers.length;
  if (colN === 0) return;

  const tableW = 9.2;
  const xStart = 0.4;
  const yStart = 1.15;
  const maxRows = Math.min(rows.length, 8);
  const rowH = Math.min(0.5, (H - yStart - 0.3) / (maxRows + 1));

  const headerRow = headers.map(h => ({
    text: h,
    options: opt({
      bold: true, color: C.WHITE, fill: { color: C.NAVY },
      fontSize: 13, fontFace: "微软雅黑", align: "center", valign: "middle",
      border: [
        { type: "solid", color: C.WHITE, pt: 1 },
        { type: "solid", color: C.WHITE, pt: 1 },
        { type: "solid", color: C.WHITE, pt: 1 },
        { type: "solid", color: C.WHITE, pt: 1 },
      ],
    }),
  }));

  const dataRows = rows.slice(0, maxRows).map((row, ri) =>
    row.map(cell => ({
      text: cell,
      options: opt({
        color: C.TEXT, fill: { color: ri % 2 === 0 ? "EEF2FF" : C.WHITE },
        fontSize: 12, fontFace: "微软雅黑", align: "center", valign: "middle",
        border: [
          { type: "solid", color: C.GRAY, pt: 1 },
          { type: "solid", color: C.GRAY, pt: 1 },
          { type: "solid", color: C.GRAY, pt: 1 },
          { type: "solid", color: C.GRAY, pt: 1 },
        ],
      }),
    })),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slide.addTable([headerRow, ...dataRows] as any, {
    x: xStart, y: yStart, w: tableW,
    rowH: rowH,
    colW: Array(colN).fill(tableW / colN) as number[],
  });
}

function renderComparison(prs: PptxGenJS, s: ComparisonSlide) {
  const slide = prs.addSlide();
  addBg(slide, C.WHITE);
  slide.addShape("rect", opt({ x: 0, y: 0, w: W, h: 1.0, fill: { color: C.NAVY } }));
  slide.addShape("rect", opt({ x: 0, y: 0, w: 0.12, h: H, fill: { color: C.GOLD } }));
  slide.addText(s.title || "", opt({
    x: 0.35, y: 0, w: 9.3, h: 1.0,
    fontSize: 20, bold: true, color: C.WHITE, fontFace: "微软雅黑", valign: "middle",
  }));

  const cols  = (s.columns || []).slice(0, 3);
  const n     = cols.length;
  if (n === 0) return;
  const gap   = 0.2;
  const colW  = (9.0 - gap * (n - 1)) / n;
  const xBase = 0.5;
  const yBase = 1.15;
  const cardH = H - yBase - 0.2;

  cols.forEach((col, i) => {
    const cx    = xBase + i * (colW + gap);
    const color = col.color || CARD_COLORS[i % CARD_COLORS.length];

    slide.addShape("rect", opt({ x: cx, y: yBase, w: colW, h: cardH, fill: { color: "F5F7FF" }, rectRadius: 0.08 }));
    slide.addShape("rect", opt({ x: cx, y: yBase, w: colW, h: 0.55, fill: { color }, rectRadius: 0.08 }));
    slide.addShape("rect", opt({ x: cx, y: yBase + 0.35, w: colW, h: 0.2, fill: { color } }));

    slide.addText(col.heading || "", opt({
      x: cx + 0.1, y: yBase + 0.05, w: colW - 0.2, h: 0.45,
      fontSize: 13, bold: true, color: C.WHITE, fontFace: "微软雅黑",
      align: "center", valign: "middle", wrap: true,
    }));

    const pts    = (col.points || []).slice(0, 6);
    const ptsN   = pts.length;
    const pStartY = yBase + 0.65;
    const pEndY   = yBase + cardH - 0.15;
    const pSpacing = ptsN > 1 ? (pEndY - pStartY) / (ptsN - 1) : 0;

    pts.forEach((pt, j) => {
      const py = ptsN === 1 ? (pStartY + pEndY) / 2 - 0.2 : pStartY + j * pSpacing;
      slide.addShape("ellipse", opt({ x: cx + 0.15, y: py + 0.07, w: 0.14, h: 0.14, fill: { color } }));
      slide.addText(pt, opt({
        x: cx + 0.36, y: py - 0.02, w: colW - 0.48, h: 0.45,
        fontSize: 12, color: C.TEXT, fontFace: "微软雅黑", valign: "middle", wrap: true,
      }));
    });
  });
}

function renderEnding(prs: PptxGenJS) {
  const slide = prs.addSlide();
  slide.addShape("rect", opt({ x: 0, y: 0, w: W, h: H, fill: { color: C.NAVY_D } }));
  slide.addShape("rect", opt({ x: 7.5, y: 0, w: 2.5, h: H, fill: { color: C.NAVY } }));
  slide.addShape("rect", opt({ x: 0.4, y: 2.2, w: 3.5, h: 0.06, fill: { color: C.GOLD } }));
  slide.addText("感谢聆听", opt({
    x: 0.4, y: 2.4, w: 6.5, h: 1.0,
    fontSize: 36, bold: true, color: C.WHITE, fontFace: "微软雅黑",
  }));
  slide.addText("欢迎提问与指导", opt({
    x: 0.4, y: 3.5, w: 6.5, h: 0.55,
    fontSize: 16, color: C.GOLD, fontFace: "微软雅黑",
  }));
}

// ── 主入口 ───────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { pptContent } = (await req.json()) as { pptContent: PptContent };
    if (!pptContent?.slides?.length) {
      return NextResponse.json({ error: "PPT 内容为空" }, { status: 400 });
    }

    const PptxGenJsModule = await import("pptxgenjs");
    const PptxGenJsCtor = PptxGenJsModule.default;
    const prs = new PptxGenJsCtor();
    prs.layout = "LAYOUT_16x9";
    prs.defineLayout({ name: "LAYOUT_16x9", width: W, height: H });

    for (const slide of pptContent.slides as Slide[]) {
      switch (slide.type) {
        case "cover":      renderCover(prs, slide);      break;
        case "contents":   renderContents(prs, slide);   break;
        case "section":    renderSection(prs, slide);    break;
        case "content":    renderContent(prs, slide);    break;
        case "stats":      renderStats(prs, slide);      break;
        case "table":      renderTable(prs, slide);      break;
        case "comparison": renderComparison(prs, slide); break;
        case "ending":     renderEnding(prs);            break;
      }
    }

    const buffer = await prs.write({ outputType: "nodebuffer" }) as Buffer;
    const filename = encodeURIComponent(
      (pptContent.title || "presentation").replace(/[\\/:"*?<>|]/g, "_") + ".pptx",
    );

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch (error) {
    console.error("PPTX 文件生成异常:", error);
    return NextResponse.json({ error: "PPTX 生成失败，请重试" }, { status: 500 });
  }
}
