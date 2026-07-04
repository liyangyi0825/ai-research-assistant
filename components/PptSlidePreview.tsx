"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { parseHighlights } from "@/lib/pptRuns";
import type {
  PptContent, Slide,
  CoverSlide, ContentsSlide, SectionSlide, ContentSlide,
  StatsSlide, TableSlide, ComparisonSlide, FigureSlide,
} from "@/app/api/ppt/generate-content/route";

// ── 颜色常量（与 generate-file 路由保持一致）────────────────────────────────
const C = {
  NAVY:   "#1B3A8C",
  NAVY_D: "#0F2361",
  GOLD:   "#C8A44A",
  WHITE:  "#FFFFFF",
  LIGHT:  "#F0F4FF",
  GRAY:   "#E0E4EE",
  TEXT:   "#1A1A2E",
  RED:    "#8B1A1A",
  ORANGE: "#B8600A",
  GREEN:  "#1B6B3A",
  PURPLE: "#5B1A7A",
};
const CARD_COLORS = [C.NAVY, C.RED, C.GREEN, C.ORANGE, C.PURPLE];
const hex = (c?: string) => {
  if (!c) return C.NAVY;
  return c.startsWith("#") ? c : `#${c}`;
};

// 内部坐标系：1000 × 562.5（对应 pptxgenjs 的 10" × 5.625"，100px/inch）
// pt 转内部 px：pt × 100/72
const f = (pt: number) => pt * 100 / 72;

// [[关键词]] → 红色加粗 span，其余文字正常渲染
function RichText({ text }: { text: string }) {
  const segs = parseHighlights(text);
  if (segs.length === 1 && !segs[0].highlight) return <>{text}</>;
  // 包一层 span：避免被外层 flex 容器把每个片段拆成独立的 flex item 导致断行错乱
  return (
    <span>
      {segs.map((seg, i) =>
        seg.highlight
          ? <span key={i} style={{ color: "#CC2200", fontWeight: 700 }}>{seg.text}</span>
          : <span key={i}>{seg.text}</span>
      )}
    </span>
  );
}

// ── 幻灯片渲染组件 ────────────────────────────────────────────────────────────

function Cover({ s }: { s: CoverSlide }) {
  const lines = (s.author || "").replace(/\\n/g, "\n").split("\n");
  return (
    <div style={{ position: "absolute", inset: 0, background: C.NAVY_D, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      {/* 右侧深色面板 */}
      <div style={{ position: "absolute", right: 0, top: 0, width: 250, bottom: 0, background: C.NAVY }} />
      {/* 金色横线 */}
      <div style={{ position: "absolute", left: 40, top: 120, width: 350, height: 6, background: C.GOLD }} />
      {/* 标题 */}
      <div style={{ position: "absolute", left: 40, top: 140, width: 680, maxHeight: 140, overflow: "hidden",
        color: C.WHITE, fontSize: f(30), fontWeight: 700, lineHeight: 1.4 }}>
        {s.title}
      </div>
      {/* 副标题 */}
      {s.subtitle && (
        <div style={{ position: "absolute", left: 40, top: 300, width: 650, color: C.GOLD, fontSize: f(14) }}>
          {s.subtitle}
        </div>
      )}
      {/* 作者信息 */}
      <div style={{ position: "absolute", left: 40, top: 355, width: 650, color: "#AABBDD", fontSize: f(12), lineHeight: 1.7 }}>
        {lines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
      {/* 日期 */}
      <div style={{ position: "absolute", left: 40, top: 430, color: "#8899BB", fontSize: f(11) }}>
        {s.date}
      </div>
      {/* 右侧装饰文字 */}
      <div style={{ position: "absolute", right: 168, top: 150, color: "#AABBDD", fontSize: f(16), fontWeight: 700,
        writingMode: "vertical-rl", letterSpacing: 8 }}>
        学术报告
      </div>
    </div>
  );
}

function Contents({ s }: { s: ContentsSlide }) {
  const items = s.items || [];
  const cols = items.length > 6 ? 2 : 1;
  const half = Math.ceil(items.length / cols);
  // 可用高度：560 - 100(header) - 20(bottom padding) = 440px，均匀分配
  const availH = 440;
  const itemH = 52;
  const totalItemH = half * itemH;
  const totalGap = availH - totalItemH;
  // 顶部留白 + 间距均匀分布
  const gapBetween = half > 1 ? (totalGap - 20) / (half - 1) : 0;
  const topPad = half > 1 ? 110 : 100 + (availH - itemH) / 2;
  return (
    <div style={{ position: "absolute", inset: 0, background: C.WHITE, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 12, bottom: 0, background: C.NAVY }} />
      <div style={{ position: "absolute", inset: "0 0 auto 0", height: 100, background: C.NAVY }} />
      <div style={{ position: "absolute", left: 35, top: 0, height: 100, display: "flex", alignItems: "center",
        color: C.WHITE, fontSize: f(24), fontWeight: 700 }}>目 录</div>
      {items.map((item, i) => {
        const col  = Math.floor(i / half);
        const row  = i % half;
        const xBase = cols === 2 ? (col === 0 ? 50 : 530) : 80;
        const colW  = cols === 2 ? 440 : 880;
        const yBase = topPad + row * (itemH + gapBetween);
        return (
          <div key={i} style={{ position: "absolute", left: xBase, top: yBase, width: colW, height: itemH, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: C.NAVY, color: C.WHITE, fontSize: f(11), fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {i + 1}
            </div>
            <div style={{ color: C.TEXT, fontSize: f(14), flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Section({ s }: { s: SectionSlide }) {
  return (
    <div style={{ position: "absolute", inset: 0, background: C.NAVY, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", right: -50, top: -50, width: 400, height: 400, background: C.NAVY_D }} />
      <div style={{ position: "absolute", right: 0, top: 150, width: 350, height: 400, background: "#162E70" }} />
      {/* 大数字居中偏上 */}
      <div style={{ position: "absolute", left: 60, top: 130, color: "#2A4DA8", fontSize: f(80), fontWeight: 900,
        lineHeight: 1, fontFamily: "'Arial Black',Impact,sans-serif" }}>
        {s.number || "01"}
      </div>
      {/* 金线和标题置于页面垂直中央 */}
      <div style={{ position: "absolute", left: 60, top: 248, width: 200, height: 7, background: C.GOLD }} />
      <div style={{ position: "absolute", left: 60, top: 265, width: 620, color: C.WHITE, fontSize: f(28), fontWeight: 700, lineHeight: 1.4 }}>
        {s.title}
      </div>
    </div>
  );
}

function ContentStandard({ s }: { s: ContentSlide }) {
  const paras = (s.paragraphs || []).slice(0, 3);
  return (
    <div style={{ position: "absolute", inset: 0, background: C.WHITE, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: "0 0 auto 0", height: 100, background: C.NAVY }} />
      <div style={{ position: "absolute", left: 0, top: 0, width: 12, bottom: 0, background: C.GOLD }} />
      <div style={{ position: "absolute", left: 35, top: 0, right: 20, height: 100, display: "flex", alignItems: "center",
        color: C.WHITE, fontSize: f(20), fontWeight: 700 }}>
        {s.title}
      </div>
      {/* 流式段落区域 */}
      <div style={{ position: "absolute", left: 35, top: 116, right: 22, bottom: 14, overflow: "hidden",
        display: "flex", flexDirection: "column", gap: 20 }}>
        {paras.map((para, i) => (
          <div key={i} style={{ color: C.TEXT, fontSize: f(14.5), lineHeight: 1.8, textAlign: "justify" }}>
            <RichText text={para} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ContentSplit({ s }: { s: ContentSlide }) {
  const paras = (s.paragraphs || []).slice(0, 3);
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      {/* 左侧深蓝面板 */}
      <div style={{ position: "absolute", left: 0, top: 0, width: 380, bottom: 0, background: C.NAVY }} />
      {/* 右侧白色区域 */}
      <div style={{ position: "absolute", left: 380, top: 0, right: 0, bottom: 0, background: C.WHITE }} />
      {/* 右侧顶部细线 */}
      <div style={{ position: "absolute", left: 380, top: 0, right: 0, height: 7, background: C.NAVY_D }} />
      {/* 左侧标题 */}
      <div style={{ position: "absolute", left: 28, top: 80, width: 324, height: 280, overflow: "hidden",
        display: "flex", alignItems: "center",
        color: C.WHITE, fontSize: f(20), fontWeight: 700, lineHeight: 1.4 }}>
        {s.title}
      </div>
      {/* 金色装饰线 */}
      <div style={{ position: "absolute", left: 28, top: 380, width: 150, height: 7, background: C.GOLD }} />
      {/* 右侧流式段落 */}
      <div style={{ position: "absolute", left: 408, top: 32, right: 18, bottom: 14, overflow: "hidden",
        display: "flex", flexDirection: "column", gap: 28 }}>
        {paras.map((para, i) => (
          <div key={i} style={{ color: C.TEXT, fontSize: f(14), lineHeight: 1.8, textAlign: "justify" }}>
            <RichText text={para} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ContentHero({ s }: { s: ContentSlide }) {
  const paras = (s.paragraphs || []).slice(0, 2);
  return (
    <div style={{ position: "absolute", inset: 0, background: C.LIGHT, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      {/* 顶部深蓝细条 */}
      <div style={{ position: "absolute", inset: "0 0 auto 0", height: 10, background: C.NAVY }} />
      {/* 底部金色细条 */}
      <div style={{ position: "absolute", inset: "auto 0 0 0", height: 10, background: C.GOLD }} />
      {/* 页面标题（小字） */}
      <div style={{ position: "absolute", left: 60, top: 18, right: 60, height: 65,
        display: "flex", alignItems: "center", color: "#5566AA", fontSize: f(15), overflow: "hidden" }}>
        {s.title}
      </div>
      {/* 金色装饰线 */}
      <div style={{ position: "absolute", left: 60, top: 90, width: 200, height: 7, background: C.GOLD }} />
      {/* 核心陈述（大字加粗） */}
      {paras[0] && (
        <div style={{ position: "absolute", left: 60, top: 110, right: 60, height: 270,
          display: "flex", alignItems: "center",
          color: C.NAVY, fontSize: f(22), fontWeight: 700, lineHeight: 1.5, overflow: "hidden" }}>
          <RichText text={paras[0]} />
        </div>
      )}
      {/* 补充说明（小字） */}
      {paras[1] && (
        <>
          <div style={{ position: "absolute", left: 60, top: 390, right: 60, height: 2, background: C.GRAY }} />
          <div style={{ position: "absolute", left: 60, top: 398, right: 60, bottom: 20,
            color: "#445588", fontSize: f(14), lineHeight: 1.4, overflow: "hidden" }}>
            <RichText text={paras[1]} />
          </div>
        </>
      )}
    </div>
  );
}

function ContentCard({ s }: { s: ContentSlide }) {
  const CARD_HEAD_COLORS = ["#1B3A8C", "#224A9A", "#2D60B0"];
  const cards = (s.cards || []).slice(0, 3);
  const n = Math.max(cards.length, 1);
  const MARGIN = 28;
  const GAP    = 18;
  const CY     = 100;          // cards 起始 y（px）
  const CH     = 442.5;        // cards 高度（px）
  const HEAD_H = 48;
  const cardW  = (1000 - 2 * MARGIN - GAP * (n - 1)) / n;

  return (
    <div style={{ position: "absolute", inset: 0, background: C.WHITE,
      fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      {/* 页面顶部深蓝标题栏 */}
      <div style={{ position: "absolute", left: 0, top: 0, right: 0, height: 85, background: C.NAVY }} />
      <div style={{ position: "absolute", left: 0, top: 0, width: 10, bottom: 0, background: C.GOLD }} />
      <div style={{ position: "absolute", left: 28, top: 0, right: 20, height: 85,
        display: "flex", alignItems: "center", color: "#fff", fontSize: f(20), fontWeight: 700 }}>
        {s.title}
      </div>
      {/* 卡片 */}
      {cards.map((card, i) => {
        const cx      = MARGIN + i * (cardW + GAP);
        const HAS_IMG = Boolean(card.imageHint);
        const pts     = (card.points || []).slice(0, HAS_IMG ? 2 : 5);
        const np      = pts.length;
        const bodyY   = HEAD_H + 10;   // 相对卡片顶部的偏移
        const bodyH   = HAS_IMG ? 110 : (CH - HEAD_H - 15);
        const gap     = 10;
        const itemH   = (bodyH - gap * Math.max(np - 1, 0)) / Math.max(np, 1);
        const fSize   = HAS_IMG ? f(12) : (np >= 4 ? f(12) : f(13));
        const hc      = CARD_HEAD_COLORS[i] ?? CARD_HEAD_COLORS[CARD_HEAD_COLORS.length - 1];
        // 图片占位框尺寸（像素）
        const imgY    = bodyY + bodyH + 8;
        const imgH    = CH - HEAD_H - bodyH - 25;
        return (
          <div key={i} style={{ position: "absolute", left: cx, top: CY, width: cardW, height: CH,
            background: "#F8FAFC", border: "0.5px solid #DDE4ED", overflow: "hidden" }}>
            {/* 深色标题栏 */}
            <div style={{ position: "absolute", left: 0, top: 0, right: 0, height: HEAD_H, background: hc }} />
            <div style={{ position: "absolute", left: 12, top: 0, right: 12, height: HEAD_H,
              display: "flex", alignItems: "center",
              color: "#fff", fontSize: f(13), fontWeight: 700 }}>
              {card.heading}
            </div>
            {/* 要点 */}
            {pts.map((pt, j) => (
              <div key={j}>
                <div style={{ position: "absolute", left: 12, top: bodyY + j * (itemH + gap), right: 12, height: itemH,
                  display: "flex", alignItems: "center",
                  color: C.TEXT, fontSize: fSize, lineHeight: 1.4, overflow: "hidden" }}>
                  <RichText text={pt} />
                </div>
                {j < np - 1 && (
                  <div style={{ position: "absolute", left: 12, top: bodyY + j * (itemH + gap) + itemH + gap * 0.4,
                    right: 12, height: 1, background: C.GRAY }} />
                )}
              </div>
            ))}
            {/* 图片占位框（有 imageHint 时） */}
            {HAS_IMG && (
              <div style={{
                position: "absolute", left: 10, right: 10,
                top: imgY, height: imgH,
                background: "#E8ECF0",
                border: "1.5px dashed #B0BEC5",
                borderRadius: 4,
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                gap: 6,
              }}>
                <div style={{ fontSize: f(14) }}>📷</div>
                <div style={{ fontSize: f(10), color: "#1B3A8C", fontWeight: 600, textAlign: "center", padding: "0 8px" }}>
                  {card.imageHint}
                </div>
                <div style={{ fontSize: f(8.5), color: "#888", textAlign: "center", padding: "0 8px" }}>
                  右键 → 更改图片
                </div>
              </div>
            )}
          </div>
        );
      })}
      {/* 流程箭头：flow=true 时在相邻卡片间画 CSS 箭头 */}
      {s.flow && cards.slice(0, -1).map((_, i) => {
        const cx_i = MARGIN + i * (cardW + GAP);
        const arrowLeft = cx_i + cardW + 2;
        const arrowTop  = CY + CH / 2 - 2;
        const lineW     = GAP - 8;
        return (
          <div key={`flow-${i}`} style={{ position: "absolute", left: arrowLeft, top: arrowTop,
            width: lineW, height: 4, background: C.NAVY }}>
            <div style={{ position: "absolute", right: -7, top: -5,
              width: 0, height: 0,
              borderTop: "7px solid transparent",
              borderBottom: "7px solid transparent",
              borderLeft: `8px solid ${C.NAVY}` }} />
          </div>
        );
      })}
    </div>
  );
}

function Content({ s }: { s: ContentSlide }) {
  const layout = s.layout ?? "standard";
  if (layout === "split") return <ContentSplit s={s} />;
  if (layout === "hero")  return <ContentHero s={s} />;
  if (layout === "card")  return <ContentCard s={s} />;
  return <ContentStandard s={s} />;
}

function Figure({ s }: { s: FigureSlide }) {
  return (
    <div style={{ position: "absolute", inset: 0, background: C.WHITE, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: "0 0 auto 0", height: 100, background: C.NAVY }} />
      <div style={{ position: "absolute", left: 0, top: 0, width: 12, bottom: 0, background: C.GOLD }} />
      <div style={{ position: "absolute", left: 35, top: 0, right: 20, height: 100, display: "flex", alignItems: "center",
        color: C.WHITE, fontSize: f(20), fontWeight: 700 }}>
        {s.title}
      </div>
      {/* 图表占位框 */}
      <div style={{
        position: "absolute", left: 50, top: 115, right: 50, height: 252,
        background: "#F5F5F5",
        border: "2px dashed #CCCCCC",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8,
      }}>
        <div style={{ color: "#AAAAAA", fontSize: f(16) }}>请在此插入图表</div>
        <div style={{ color: "#CCCCCC", fontSize: f(11) }}>{s.title}</div>
      </div>
      {/* 图表说明（figure_desc）：占位框下方，分析区上方 */}
      {s.figure_desc && (
        <div style={{ position: "absolute", left: 50, top: 374, right: 50, height: 28,
          color: "#666666", fontSize: f(10), fontStyle: "italic", lineHeight: 1.4,
          overflow: "hidden", textAlign: "left" }}>
          {s.figure_desc}
        </div>
      )}
      {/* 分隔线 */}
      <div style={{ position: "absolute", left: 35, top: 408, right: 20, height: 2, background: C.GRAY }} />
      {/* 分析内容 */}
      <div style={{ position: "absolute", left: 35, top: 418, right: 20, bottom: 15,
        color: C.TEXT, fontSize: f(13), lineHeight: 1.6, overflow: "hidden" }}>
        {s.analysis}
      </div>
    </div>
  );
}

function Stats({ s }: { s: StatsSlide }) {
  const stats = (s.stats || []).slice(0, 4);
  const n = stats.length;
  const cardW   = n >= 4 ? 210 : n === 3 ? 280 : n === 2 ? 400 : 600;
  const totalW  = cardW * n + 25 * (n - 1);
  const startX  = (1000 - totalW) / 2;
  return (
    <div style={{ position: "absolute", inset: 0, background: C.LIGHT, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: "0 0 auto 0", height: 100, background: C.NAVY }} />
      <div style={{ position: "absolute", left: 0, top: 0, width: 12, bottom: 0, background: C.GOLD }} />
      <div style={{ position: "absolute", left: 35, top: 0, right: 20, height: 100, display: "flex", alignItems: "center",
        color: C.WHITE, fontSize: f(20), fontWeight: 700 }}>
        {s.title}
      </div>
      {stats.map((st, i) => {
        const cx    = startX + i * (cardW + 25);
        const color = hex(st.color || CARD_COLORS[i % CARD_COLORS.length]);
        return (
          <div key={i} style={{ position: "absolute", left: cx, top: 130, width: cardW, height: 370, background: color, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 50, left: 10, right: 10, textAlign: "center",
              color: C.WHITE, fontSize: n >= 4 ? f(34) : f(42), fontWeight: 900, fontFamily: "'Arial Black',sans-serif" }}>
              {st.value}
            </div>
            <div style={{ position: "absolute", top: 195, left: 10, right: 10, textAlign: "center",
              color: "#DDEEFF", fontSize: f(13), fontWeight: 700 }}>
              {st.unit}
            </div>
            <div style={{ position: "absolute", top: 255, left: 30, right: 30, height: 2, background: "rgba(255,255,255,0.3)" }} />
            <div style={{ position: "absolute", top: 265, left: 10, right: 10, textAlign: "center",
              color: "#CCDDEF", fontSize: f(12), lineHeight: 1.4 }}>
              {st.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Table({ s }: { s: TableSlide }) {
  const headers = s.headers || [];
  const rows    = (s.rows || []).slice(0, 8);
  const colN    = headers.length;
  if (!colN) return null;
  const tableW  = 920;
  const xStart  = 40;
  const yStart  = 115;
  const colW    = tableW / colN;
  const maxRows = rows.length;
  const rowH    = Math.min(50, 430 / (maxRows + 1));
  return (
    <div style={{ position: "absolute", inset: 0, background: C.WHITE, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: "0 0 auto 0", height: 100, background: C.NAVY }} />
      <div style={{ position: "absolute", left: 0, top: 0, width: 12, bottom: 0, background: C.GOLD }} />
      <div style={{ position: "absolute", left: 35, top: 0, right: 20, height: 100, display: "flex", alignItems: "center",
        color: C.WHITE, fontSize: f(20), fontWeight: 700 }}>
        {s.title}
      </div>
      {/* 表头 */}
      <div style={{ position: "absolute", left: xStart, top: yStart, width: tableW, height: rowH, display: "flex" }}>
        {headers.map((h, i) => (
          <div key={i} style={{ width: colW, height: rowH, background: C.NAVY, border: "1px solid white", boxSizing: "border-box",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: C.WHITE, fontSize: f(13), fontWeight: 700, padding: "0 4px", textAlign: "center" }}>
            {h}
          </div>
        ))}
      </div>
      {/* 数据行 */}
      {rows.map((row, ri) => (
        <div key={ri} style={{ position: "absolute", left: xStart, top: yStart + rowH * (ri + 1), width: tableW, height: rowH, display: "flex" }}>
          {row.map((cell, ci) => (
            <div key={ci} style={{ width: colW, height: rowH, background: ri % 2 === 0 ? "#EEF2FF" : C.WHITE,
              border: `1px solid ${C.GRAY}`, boxSizing: "border-box",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: C.TEXT, fontSize: f(12), padding: "0 4px", textAlign: "center" }}>
              {cell}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Comparison({ s }: { s: ComparisonSlide }) {
  const cols  = (s.columns || []).slice(0, 3);
  const n     = cols.length;
  if (!n) return null;
  const gap   = 20;
  const colW  = (900 - gap * (n - 1)) / n;
  const xBase = 50;
  const yBase = 115;
  const cardH = 562.5 - yBase - 20;
  return (
    <div style={{ position: "absolute", inset: 0, background: C.WHITE, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: "0 0 auto 0", height: 100, background: C.NAVY }} />
      <div style={{ position: "absolute", left: 0, top: 0, width: 12, bottom: 0, background: C.GOLD }} />
      <div style={{ position: "absolute", left: 35, top: 0, right: 20, height: 100, display: "flex", alignItems: "center",
        color: C.WHITE, fontSize: f(20), fontWeight: 700 }}>
        {s.title}
      </div>
      {cols.map((col, i) => {
        const cx     = xBase + i * (colW + gap);
        const color  = hex(col.color || CARD_COLORS[i % CARD_COLORS.length]);
        const pts    = (col.points || []).slice(0, 6);
        const ptsN   = pts.length;
        const pStartY = 55;
        const pEndY   = cardH - 15;
        const pSpacing = ptsN > 1 ? (pEndY - pStartY) / (ptsN - 1) : 0;
        return (
          <div key={i} style={{ position: "absolute", left: cx, top: yBase, width: colW, height: cardH, background: "#F5F7FF", borderRadius: 8, overflow: "hidden" }}>
            {/* 顶部彩色标题条 */}
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 55, background: color,
              display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ color: C.WHITE, fontSize: f(13), fontWeight: 700, textAlign: "center", padding: "0 10px", lineHeight: 1.3 }}>
                {col.heading}
              </div>
            </div>
            {/* 要点列表 */}
            {pts.map((pt, j) => {
              const py = ptsN === 1 ? (pStartY + pEndY) / 2 - 20 : pStartY + j * pSpacing;
              return (
                <div key={j} style={{ position: "absolute", left: 15, top: py, right: 10, display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ width: 14, height: 14, borderRadius: "50%", background: color, flexShrink: 0, marginTop: 3 }} />
                  <div style={{ color: C.TEXT, fontSize: f(12), lineHeight: 1.4 }}>{pt}</div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function Ending() {
  return (
    <div style={{ position: "absolute", inset: 0, background: C.NAVY_D, fontFamily: "'Microsoft YaHei','PingFang SC',sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", right: 0, top: 0, width: 250, bottom: 0, background: C.NAVY }} />
      <div style={{ position: "absolute", left: 40, top: 220, width: 350, height: 6, background: C.GOLD }} />
      <div style={{ position: "absolute", left: 40, top: 240, color: C.WHITE, fontSize: f(36), fontWeight: 700 }}>
        感谢聆听
      </div>
      <div style={{ position: "absolute", left: 40, top: 350, color: C.GOLD, fontSize: f(16) }}>
        欢迎提问与指导
      </div>
    </div>
  );
}

// ── 渲染分发 ──────────────────────────────────────────────────────────────────
function renderSlide(slide: Slide) {
  switch (slide.type) {
    case "cover":      return <Cover s={slide} />;
    case "contents":   return <Contents s={slide} />;
    case "section":    return <Section s={slide} />;
    case "content":    return <Content s={slide} />;
    case "figure":     return <Figure s={slide} />;
    case "stats":      return <Stats s={slide} />;
    case "table":      return <Table s={slide} />;
    case "comparison": return <Comparison s={slide} />;
    case "ending":     return <Ending />;
    default:           return null;
  }
}

// ── 缩略图颜色 & 标签 ─────────────────────────────────────────────────────────
const TYPE_BADGE: Record<string, { bg: string; label: string }> = {
  cover:      { bg: "#4F46E5", label: "封面" },
  contents:   { bg: "#7C3AED", label: "目录" },
  section:    { bg: "#1D4ED8", label: "章节" },
  content:    { bg: "#374151", label: "内容" },
  figure:     { bg: "#0D7090", label: "图表" },
  stats:      { bg: "#B45309", label: "数据" },
  table:      { bg: "#0D9488", label: "表格" },
  comparison: { bg: "#C2410C", label: "对比" },
  ending:     { bg: "#4B5563", label: "结尾" },
};

// ── 主组件 ────────────────────────────────────────────────────────────────────
export function PptSlidePreview({ pptContent }: { pptContent: PptContent }) {
  const [idx, setIdx]       = useState(0);
  const [scale, setScale]   = useState(0.5);
  const containerRef        = useRef<HTMLDivElement>(null);
  const thumbRef            = useRef<HTMLDivElement>(null);

  // 可变 slides 状态（支持单页替换）
  const [slides, setSlides] = useState<Slide[]>(pptContent.slides || []);
  useEffect(() => { setSlides(pptContent.slides || []); }, [pptContent]);

  // 单页重生成状态
  const [editOpen,     setEditOpen]     = useState(false);
  const [instruction,  setInstruction]  = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [regenError,   setRegenError]   = useState<string | null>(null);

  // 响应式缩放：容器宽度 / 内部 1000px
  useEffect(() => {
    const update = () => {
      if (containerRef.current) {
        setScale(containerRef.current.clientWidth / 1000);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const total = slides.length;
  const slide = slides[idx];

  const prev = useCallback(() => { setIdx(i => Math.max(0, i - 1)); setEditOpen(false); setRegenError(null); }, []);
  const next = useCallback(() => { setIdx(i => Math.min(total - 1, i + 1)); setEditOpen(false); setRegenError(null); }, [total]);

  // 单页重新生成
  const handleRegenerate = useCallback(async () => {
    if (!instruction.trim() || regenerating) return;
    setRegenerating(true);
    setRegenError(null);
    try {
      const res = await fetch("/api/ppt/regenerate-slide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentSlide: slides[idx],
          prevSlide:    idx > 0 ? slides[idx - 1] : null,
          nextSlide:    idx < slides.length - 1 ? slides[idx + 1] : null,
          userInstruction: instruction,
          scene: pptContent.scene ?? "defense",
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "生成失败");
      setSlides(prev => prev.map((s, i) => i === idx ? data.slide : s));
      setEditOpen(false);
      setInstruction("");
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : "生成失败，请重试");
    } finally {
      setRegenerating(false);
    }
  }, [instruction, regenerating, slides, idx, pptContent.scene]);

  // 切换页时让缩略图滚入可视区
  useEffect(() => {
    if (thumbRef.current) {
      const thumbItem = thumbRef.current.children[idx] as HTMLElement;
      thumbItem?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [idx]);

  // 键盘左右翻页
  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft")  prev();
    if (e.key === "ArrowRight") next();
  }, [prev, next]);

  const badge = slide ? (TYPE_BADGE[slide.type] ?? { bg: "#374151", label: slide.type }) : null;

  return (
    <div className="select-none" onKeyDown={handleKey} tabIndex={0} style={{ outline: "none" }}>
      {/* ── 主幻灯片视图 ── */}
      <div
        ref={containerRef}
        style={{ position: "relative", width: "100%", paddingTop: "56.25%" }}
      >
        <div style={{
          position: "absolute", inset: 0, overflow: "hidden",
          borderRadius: 10, boxShadow: "0 4px 24px rgba(0,0,0,0.18)",
          border: "1px solid #E5E7EB", background: "#F0F0F0",
        }}>
          <div style={{ width: 1000, height: 562.5, transform: `scale(${scale})`, transformOrigin: "top left" }}>
            {slide && renderSlide(slide)}
          </div>
          {/* 重新生成时显示半透明遮罩 */}
          {regenerating && (
            <div style={{
              position: "absolute", inset: 0, background: "rgba(255,255,255,0.75)",
              display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: 10, zIndex: 10,
            }}>
              <span className="text-sm text-gray-500 animate-pulse">✨ AI 生成中…</span>
            </div>
          )}
        </div>
      </div>

      {/* ── 导航栏 ── */}
      <div className="flex items-center justify-between mt-3 px-1">
        {/* 左翻 */}
        <button
          onClick={prev}
          disabled={idx === 0}
          className="px-4 py-1.5 text-sm rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          ← 上一页
        </button>

        {/* 页码 + 类型标签 */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">{idx + 1} / {total}</span>
          {badge && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full text-white"
              style={{ background: badge.bg }}>
              {badge.label}
            </span>
          )}
        </div>

        {/* 右翻 */}
        <button
          onClick={next}
          disabled={idx === total - 1}
          className="px-4 py-1.5 text-sm rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          下一页 →
        </button>
      </div>

      {/* ── 单页修改面板 ── */}
      <div className="mt-2">
        {!editOpen ? (
          <button
            onClick={() => { setEditOpen(true); setRegenError(null); }}
            className="w-full py-1.5 text-sm rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
          >
            ✏️ 修改这一页
          </button>
        ) : (
          <div className="border border-indigo-200 rounded-xl p-3 bg-indigo-50 space-y-2">
            <textarea
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              placeholder="告诉 AI 你想怎么改这一页，例如：加一张示意图、改成左图右文版式、把这页拆成两页…"
              rows={2}
              className="w-full text-sm rounded-lg border border-indigo-200 bg-white px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400 placeholder-gray-400"
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleRegenerate(); }}
            />
            <div className="flex gap-2">
              <button
                onClick={handleRegenerate}
                disabled={regenerating || !instruction.trim()}
                className="flex-1 py-1.5 text-sm rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {regenerating ? "AI 生成中…" : "重新生成"}
              </button>
              <button
                onClick={() => { setEditOpen(false); setInstruction(""); setRegenError(null); }}
                disabled={regenerating}
                className="px-4 py-1.5 text-sm rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                取消
              </button>
            </div>
            {regenError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                ⚠️ {regenError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── 缩略图条 ── */}
      <div
        ref={thumbRef}
        className="flex gap-1.5 overflow-x-auto mt-2 pb-1"
        style={{ scrollbarWidth: "thin" }}
      >
        {slides.map((sl, i) => {
          const b = TYPE_BADGE[sl.type] ?? { bg: "#374151", label: "" };
          const isDark = ["cover", "section", "ending"].includes(sl.type);
          return (
            <button
              key={i}
              onClick={() => setIdx(i)}
              title={`第 ${i + 1} 页${sl.type === "section" ? `：${"number" in sl ? sl.number : ""}` : ""}`}
              className="flex-shrink-0 flex flex-col items-center justify-center gap-1 rounded transition-all"
              style={{
                width: 56, height: 32,
                background: isDark ? C.NAVY_D : "#F0F4FF",
                border: `2px solid ${i === idx ? b.bg : "transparent"}`,
                boxShadow: i === idx ? `0 0 0 1px ${b.bg}` : "none",
                opacity: i === idx ? 1 : 0.7,
              }}
            >
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: b.bg }} />
              <div style={{ fontSize: 9, color: isDark ? "#AABBDD" : "#6B7280", fontWeight: i === idx ? 700 : 400 }}>
                {i + 1}
              </div>
            </button>
          );
        })}
      </div>

      {/* ── 幻灯片类型统计 ── */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {Object.entries(
          slides.reduce<Record<string, number>>((acc, sl) => {
            acc[sl.type] = (acc[sl.type] || 0) + 1;
            return acc;
          }, {}),
        ).map(([type, count]) => {
          const b = TYPE_BADGE[type] ?? { bg: "#374151", label: type };
          return (
            <span key={type} className="text-xs px-2 py-0.5 rounded-full border"
              style={{ borderColor: b.bg, color: b.bg }}>
              {b.label} ×{count}
            </span>
          );
        })}
      </div>
    </div>
  );
}
