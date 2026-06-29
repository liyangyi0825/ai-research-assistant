"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// ── 数学公式保护（防止翻译 API 破坏公式）────────────────────────────────────
const MATH_PLACEHOLDER_RE = /⟨MATH_(\d+)⟩/g;

function extractMathFormulas(text: string): { maskedText: string; formulas: string[] } {
  const formulas: string[] = [];
  const mathRe =
    /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?:\\[a-zA-Z]+(?:\{[^}]*\}|\[[^\]]*\])*(?:[_^]\{[^}]*\})*)+)/g;
  const maskedText = text.replace(mathRe, (match) => {
    if (/^\\[a-z]$/.test(match)) return match;
    const idx = formulas.length;
    formulas.push(match);
    return `⟨MATH_${idx}⟩`;
  });
  return { maskedText, formulas };
}

function restoreMathFormulas(text: string, formulas: string[]): string {
  return text.replace(MATH_PLACEHOLDER_RE, (_, idx) => formulas[parseInt(idx)] ?? _);
}

// ── SSE 流解析（复用 translate 页面的实现）────────────────────────────────
async function* streamAnthropicSSE(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (
            parsed.type === "content_block_delta" &&
            parsed.delta?.type === "text_delta" &&
            typeof parsed.delta.text === "string"
          ) {
            yield parsed.delta.text;
          }
        } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── 每页状态（仅用于左侧 PDF 渲染和 OCR 阶段）──────────────────────────────
type PageStatus = "pending" | "translating" | "done" | "error" | "empty";

interface PageState {
  canvasHeight: number;
  text: string;
  translation: string;
  status: PageStatus;
}

// ── 段落状态（右侧逐段翻译显示）──────────────────────────────────────────────
type ParaStatus = "pending" | "translating" | "done" | "skipped";

interface ParaState {
  pageNum: number;
  origText: string;
  formulas: string[];
  maskedText: string;
  translation: string;
  status: ParaStatus;
}

// 按双换行或句末换行切段落，保证每段不超过合理长度
function splitIntoParagraphs(text: string): string[] {
  const byDouble = text.split(/\n{2,}/).map(s => s.replace(/\n/g, " ").trim()).filter(s => s.length > 10);
  if (byDouble.length > 1) return byDouble;

  // 单换行回退：按句末 + 大写开头识别段落边界
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
  const result: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur && /[.!?]$/.test(cur) && /^[A-Z0-9]/.test(line)) {
      result.push(cur.trim());
      cur = line;
    } else {
      cur += (cur ? " " : "") + line;
    }
    if (cur.length > 600) { result.push(cur.trim()); cur = ""; }
  }
  if (cur.trim()) result.push(cur.trim());
  return result.filter(s => s.length > 10);
}

// 超长段落按句子拆成 ≤maxLen 的块，每块单独请求，响应更快
function splitLongPara(text: string, maxLen = 500): string[] {
  if (text.length <= maxLen) return [text];
  const result: string[] = [];
  const sents = text.match(/[^.!?。！？]+[.!?。！？]+\s*/g) ?? [text];
  let cur = "";
  for (const s of sents) {
    if (cur.length + s.length > maxLen && cur) { result.push(cur.trim()); cur = s; }
    else { cur += s; }
  }
  if (cur.trim()) result.push(cur.trim());
  return result;
}

// ── 翻译文本渲染（支持 KaTeX 数学公式 + 图表说明特殊样式）──────────────────
export function TranslationText({ text }: { text: string }) {
  // \tag{N} → \quad (N)，防止 KaTeX 在部分环境下渲染失败
  const processed = text.replace(/\\tag\{([^}]*)\}/g, "\\quad ($1)");
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false, output: "htmlAndMathml" }]]}
      components={{
        p: ({ children }) => (
          <p style={{ marginBottom: "0.85em", lineHeight: "1.75" }}>{children}</p>
        ),
        // 图注：AI 输出为 blockquote（> 图1：...），紧贴图片、独立成块、与原文位置对齐
        blockquote: ({ children }) => (
          <blockquote style={{
            margin: "1em 0",
            padding: "5px 12px",
            borderLeft: "3px solid #9ca3af",
            fontStyle: "italic",
            color: "#555",
            fontSize: "12px",
            lineHeight: "1.65",
            background: "#f0f0f0",
            borderRadius: "0 4px 4px 0",
          }}>
            {children}
          </blockquote>
        ),
        // 行内代码用继承字体，避免等宽字体破坏排版
        code: ({ children }) => (
          <code style={{ fontFamily: "inherit", background: "rgba(0,0,0,0.06)", padding: "0 3px", borderRadius: 2 }}>
            {children}
          </code>
        ),
      }}
    >
      {processed}
    </ReactMarkdown>
  );
}

// ── 骨架屏 ─────────────────────────────────────────────────────────────────
function Skeleton() {
  return (
    <div className="space-y-2 animate-pulse pt-2">
      <div className="h-3 bg-gray-200 rounded w-full" />
      <div className="h-3 bg-gray-200 rounded w-5/6" />
      <div className="h-3 bg-gray-200 rounded w-4/6" />
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────
interface Props {
  file: File;
  onBack: () => void;
  onPageTranslated?: (pages: { text: string; translation: string }[]) => Promise<void> | void;
  onTranslationEnd?: () => Promise<void> | void;
  /** 恢复时传入已翻译内容，按页索引顺序。有值的页直接显示，不再调用翻译 API */
  initialTranslations?: { text: string; translation: string }[];
}

export function PdfTranslationView({ file, onBack, onPageTranslated, onTranslationEnd, initialTranslations }: Props) {
  const [numPages, setNumPages]           = useState(0);
  const [renderedPages, setRenderedPages] = useState(0);
  const [pages, setPages]                 = useState<PageState[]>([]);
  const [paras, setParas]                 = useState<ParaState[]>([]);
  const [transProgress, setTransProgress] = useState({ done: 0, total: 0 });
  const [ocrProgress, setOcrProgress]     = useState({ done: 0, total: 0 });
  const [phase, setPhase]                 = useState<"idle" | "rendering" | "ocr" | "translating" | "done">("idle");
  const [globalError, setGlobalError]     = useState("");
  const [isScannedPdf, setIsScannedPdf]   = useState(false);
  const leftRef    = useRef<HTMLDivElement>(null);
  const rightRef   = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  // ── 加载、渲染 PDF，然后逐页翻译 ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function run() {
      const container = leftRef.current;
      if (!container) return;
      container.innerHTML = "";
      setPages([]);
      setParas([]);
      setPhase("rendering");
      setGlobalError("");

      let objectUrl = "";
      try {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        objectUrl = URL.createObjectURL(file);
        const pdfDoc = await pdfjsLib.getDocument({ url: objectUrl }).promise;
        if (cancelled) return;

        const total = pdfDoc.numPages;
        setNumPages(total);

        // ── 第一阶段：渲染所有页面（与服务端文字提取并行）──────────────────
        const initialPages: PageState[] = [];

        // 服务端 unpdf 提取与 PDF.js 渲染并行进行，兼容性更好
        const serverExtractPromise = (async (): Promise<string[] | null> => {
          try {
            const fd = new FormData();
            fd.append("file", file);
            const res = await fetch("/api/extract-pages", { method: "POST", body: fd });
            if (!res.ok) return null;
            const data = await res.json() as { pages?: string[] };
            return data.pages ?? null;
          } catch { return null; }
        })();

        for (let pageNum = 1; pageNum <= total; pageNum++) {
          if (cancelled) break;

          const page = await pdfDoc.getPage(pageNum);
          if (cancelled) break;

          // 渲染到 canvas
          const containerWidth = Math.max(container.clientWidth, 300);
          const baseViewport   = page.getViewport({ scale: 1 });
          const dpr            = window.devicePixelRatio || 1;
          const scale          = (containerWidth / baseViewport.width) * dpr;
          const viewport       = page.getViewport({ scale });

          const canvas = document.createElement("canvas");
          canvas.width  = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const cssW = Math.floor(viewport.width  / dpr);
          const cssH = Math.floor(viewport.height / dpr);
          canvas.style.width  = cssW + "px";
          canvas.style.height = cssH + "px";
          canvas.style.display = "block";

          const wrapper = document.createElement("div");
          wrapper.dataset.page = String(pageNum);
          wrapper.style.cssText =
            "margin-bottom:8px;background:#fff;" +
            "box-shadow:0 1px 4px rgba(0,0,0,0.15);overflow:hidden;";
          wrapper.appendChild(canvas);
          container.appendChild(wrapper);

          await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
          if (cancelled) break;

          // 文字由服务端 unpdf 提取（与渲染并行），这里先占位
          const pageState: PageState = {
            canvasHeight: cssH,
            text: "",
            translation: "",
            status: "pending",
          };
          initialPages.push(pageState);
          setPages([...initialPages]);
          setRenderedPages(pageNum);
        }

        if (cancelled) return;

        // 等待服务端 unpdf 提取结果，填充每页文字
        const serverPages = await serverExtractPromise;
        if (serverPages === null) {
          setGlobalError("PDF 文字提取失败，请稍后重试");
          setPhase("idle");
          return;
        }
        for (let i = 0; i < initialPages.length; i++) {
          const pageText = (serverPages[i] ?? "").trim();
          initialPages[i].text = pageText;
          initialPages[i].status = pageText ? "pending" : "empty";
        }
        setPages([...initialPages]);

        // ── 阶段 1.5（新）：对空页逐页跑腾讯云 OCR ──────────────────────────
        // 只有 status === "empty"（unpdf 提取不到文字）的页面才进 OCR，
        // 覆盖纯扫描件（全部空页）和混合 PDF（部分空页）两种情况。
        const emptyIndexes = initialPages
          .map((_, i) => i)
          .filter(i => initialPages[i].status === "empty");

        if (emptyIndexes.length > 0) {
          setPhase("ocr");
          setOcrProgress({ done: 0, total: emptyIndexes.length });

          for (let ei = 0; ei < emptyIndexes.length; ei++) {
            if (cancelled) break;
            const i = emptyIndexes[ei];
            const wrapper = container.querySelector<HTMLElement>(`[data-page="${i + 1}"]`);
            const canvas  = wrapper?.querySelector<HTMLCanvasElement>("canvas");

            if (canvas) {
              try {
                const imageBase64 = canvas.toDataURL("image/jpeg", 0.85);
                const res = await fetch("/api/ocr-page", {
                  method:  "POST",
                  headers: { "Content-Type": "application/json" },
                  body:    JSON.stringify({ imageBase64 }),
                  signal:  AbortSignal.timeout(30000),
                });
                if (res.ok) {
                  const data = await res.json() as { text?: string };
                  const ocrText = (data.text ?? "").trim();
                  if (ocrText) {
                    initialPages[i].text   = ocrText;
                    initialPages[i].status = "pending";
                  }
                }
              } catch (e) {
                console.error(`第 ${i + 1} 页 OCR 失败:`, e);
                // 静默失败，保持 empty，不影响其他页
              }
            }

            setOcrProgress({ done: ei + 1, total: emptyIndexes.length });
            setPages([...initialPages]);
          }
        }

        // OCR 结束后再检查：若全部页面仍无文字，说明 OCR 也无法识别（真正的图片 PDF）
        const totalChars = initialPages.reduce((sum, p) => sum + p.text.length, 0);
        if (totalChars < 50 && initialPages.length > 0) {
          setIsScannedPdf(true);
          setPhase("done");
          return;
        }

        // ── 第二阶段：把所有页面文本拆成段落，逐段翻译 ─────────────────────────
        const allParas: ParaState[] = [];
        const pageTranslationsMap: Record<number, string> = {};

        for (let i = 0; i < initialPages.length; i++) {
          const pageText = initialPages[i].text;
          if (!pageText.trim()) continue;

          // 恢复会话：该页已有译文，整页作为一个"已完成"段落，不重复翻译
          const preTranslation = initialTranslations?.[i]?.translation?.trim();
          if (preTranslation) {
            allParas.push({
              pageNum: i + 1, origText: pageText, formulas: [], maskedText: pageText,
              translation: preTranslation, status: "done",
            });
            pageTranslationsMap[i + 1] = preTranslation;
            continue;
          }

          for (const para of splitIntoParagraphs(pageText)) {
            const { maskedText, formulas } = extractMathFormulas(para);
            // 去掉占位符后剩余文本极少 → 全是公式，直接保留原文跳过翻译
            const leftover = maskedText.replace(/⟨MATH_\d+⟩/g, "").trim();
            const isFormulaOnly = leftover.length < 15;
            allParas.push({
              pageNum: i + 1, origText: para, formulas, maskedText,
              translation: isFormulaOnly ? para : "",
              status: isFormulaOnly ? "skipped" : "pending",
            });
          }
        }

        setParas([...allParas]);
        const pendingParas = allParas.filter(p => p.status === "pending");
        setTransProgress({ done: 0, total: pendingParas.length });
        setPhase("translating");

        let translatedCount = 0;
        let isFirst = true;

        for (let pi = 0; pi < allParas.length; pi++) {
          if (cancelled) break;
          const para = allParas[pi];

          if (para.status !== "pending") {
            // 已跳过或已恢复的段落，直接累计到对应页
            pageTranslationsMap[para.pageNum] =
              (pageTranslationsMap[para.pageNum] ?? "") + para.translation + "\n\n";
            continue;
          }

          // 标记为翻译中
          allParas[pi] = { ...allParas[pi], status: "translating" };
          setParas([...allParas]);

          try {
            // 超长段落拆成 ≤500 字子块，每块单独请求，用户持续看到更新
            const subChunks = splitLongPara(para.maskedText, 500);
            let fullTranslation = "";

            for (const subChunk of subChunks) {
              const res = await fetch("/api/translate-page", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pageNum: para.pageNum, text: subChunk, isFirst }),
                signal: AbortSignal.timeout(60000),
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((data as { error?: string }).error || "翻译失败");
              }
              isFirst = false;

              let chunkText = "";
              for await (const chunk of streamAnthropicSSE(res)) {
                if (cancelled) break;
                chunkText += chunk;
                // 实时显示：流式阶段先显示含占位符的中间态
                allParas[pi] = { ...allParas[pi], translation: fullTranslation + chunkText };
                setParas([...allParas]);
              }
              // 子块完成后还原公式
              fullTranslation += restoreMathFormulas(chunkText.trim(), para.formulas);
              if (subChunks.length > 1) fullTranslation += " ";
            }

            fullTranslation = fullTranslation.trim();
            allParas[pi] = { ...allParas[pi], status: "done", translation: fullTranslation };
            setParas([...allParas]);

            pageTranslationsMap[para.pageNum] =
              (pageTranslationsMap[para.pageNum] ?? "") + fullTranslation + "\n\n";

            // 该段是本页最后一段时通知父组件保存
            const isLastOfPage =
              pi + 1 >= allParas.length || allParas[pi + 1].pageNum !== para.pageNum;
            if (isLastOfPage && !cancelled && onPageTranslated) {
              await onPageTranslated(initialPages.map((p, idx) => ({
                text: p.text,
                translation: pageTranslationsMap[idx + 1] ?? "",
              })));
            }

            translatedCount++;
            setTransProgress({ done: translatedCount, total: pendingParas.length });
          } catch (e) {
            console.error(`第 ${para.pageNum} 页段落翻译失败:`, e);
            allParas[pi] = { ...allParas[pi], status: "done", translation: "【翻译失败，请刷新重试】" };
            setParas([...allParas]);
            if (isFirst && e instanceof Error && e.message.includes("次数已用完")) {
              setGlobalError(e.message);
              break;
            }
          }
        }

        if (!cancelled) {
          setPhase("done");
          if (onTranslationEnd) await onTranslationEnd();
        }
      } catch (err) {
        if (!cancelled) {
          setGlobalError(err instanceof Error ? err.message : "PDF 加载失败，请重试");
          setPhase("idle");
        }
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    }

    run();
    return () => { cancelled = true; };
  }, [file]);

  // ── 同步滚动 ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const leftEl  = leftRef.current;
    const rightEl = rightRef.current;
    if (!leftEl || !rightEl) return;

    const left  = leftEl;
    const right = rightEl;

    function onLeftScroll() {
      if (syncingRef.current) return;
      syncingRef.current = true;
      right.scrollTop = left.scrollTop;
      syncingRef.current = false;
    }
    function onRightScroll() {
      if (syncingRef.current) return;
      syncingRef.current = true;
      left.scrollTop = right.scrollTop;
      syncingRef.current = false;
    }

    left.addEventListener("scroll",  onLeftScroll,  { passive: true });
    right.addEventListener("scroll", onRightScroll, { passive: true });
    return () => {
      left.removeEventListener("scroll",  onLeftScroll);
      right.removeEventListener("scroll", onRightScroll);
    };
  }, []);

  // ── 工具栏状态文字 ────────────────────────────────────────────────────────
  function renderStatus() {
    if (phase === "rendering") {
      return (
        <span className="text-xs text-blue-500 bg-blue-50 px-2 py-0.5 rounded-full">
          渲染第 {renderedPages} / {numPages} 页…
        </span>
      );
    }
    if (phase === "ocr") {
      return (
        <span className="text-xs text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">
          OCR 识别第 {ocrProgress.done + 1} / {ocrProgress.total} 页…
        </span>
      );
    }
    if (phase === "translating") {
      return (
        <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
          正在翻译 第 {transProgress.done + 1} / {transProgress.total} 页…
        </span>
      );
    }
    if (phase === "done" && !isScannedPdf) {
      return (
        <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
          ✓ 翻译完成，共 {numPages} 页
        </span>
      );
    }
    return null;
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100 overflow-hidden">

      {/* ── 顶部工具栏 ── */}
      <div className="shrink-0 bg-white border-b border-gray-200 shadow-sm">
        <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
          <Button variant="outline" size="sm" onClick={onBack}>← 重新上传</Button>
          <span className="text-sm font-medium text-gray-700">📖 全文对照翻译</span>
          {renderStatus()}
        </div>
        <div className="grid grid-cols-2 gap-px bg-gray-200">
          <div className="bg-blue-50 px-4 py-1.5 text-xs font-semibold text-blue-700 uppercase tracking-wide">
            English 原文
          </div>
          <div className="bg-amber-50 px-4 py-1.5 text-xs font-semibold text-amber-700 uppercase tracking-wide">
            中文译文
          </div>
        </div>
      </div>

      {/* 全局错误（用量超限等） */}
      {globalError && (
        <div className="mx-4 mt-3 p-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm shrink-0">
          ❌ {globalError}
        </div>
      )}

      {/* ── 主内容（左 PDF / 右翻译，或扫描版提示） ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {isScannedPdf ? (
          /* 扫描版 PDF 无法提取文字，给出引导 */
          <div className="flex-1 flex items-center justify-center p-6 bg-gray-50">
            <div className="bg-white rounded-2xl shadow-sm border border-amber-200 p-8 max-w-lg w-full">
              <div className="text-4xl mb-3">⚠️</div>
              <h2 className="text-lg font-semibold text-gray-800 mb-2">检测到扫描版 PDF</h2>
              <p className="text-sm text-gray-500 mb-4 leading-6">
                这篇论文以图片形式存储，暂时无法提取文字。
              </p>
              <div className="bg-blue-50 rounded-xl p-4 text-sm text-gray-700 mb-5">
                <p className="font-medium text-blue-700 mb-2">推荐重新下载文字版：</p>
                <ol className="space-y-2 text-gray-600">
                  <li className="flex gap-2">
                    <span className="shrink-0 font-medium text-blue-500">1.</span>
                    <span>打开 <strong>arxiv.org</strong> 搜索论文标题（大多数论文都有免费 PDF）</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 font-medium text-blue-500">2.</span>
                    <span>在 <strong>Google Scholar</strong> 搜索标题，点击右边的 [PDF] 链接下载</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="shrink-0 font-medium text-blue-500">3.</span>
                    <span>去期刊官网直接下载</span>
                  </li>
                </ol>
                <p className="text-gray-400 text-xs mt-3 pt-2 border-t border-blue-100">
                  文字版 PDF 可以选中文字，下载后重新上传即可。
                </p>
              </div>
              <div className="flex gap-3">
                <a
                  href="https://arxiv.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-center px-4 py-2.5 bg-blue-500 text-white text-sm rounded-xl hover:bg-blue-600 transition-colors"
                >
                  去 arXiv 搜索
                </a>
                <button
                  onClick={onBack}
                  className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-600 text-sm rounded-xl hover:bg-gray-50 transition-colors"
                >
                  重新上传
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 左：PDF 逐页渲染 */}
            <div
              ref={leftRef}
              className="w-1/2 overflow-y-auto overflow-x-hidden bg-gray-300 p-4"
            />

            {/* 右：逐段翻译（段落完成立即渲染） */}
            <div
              ref={rightRef}
              className="w-1/2 overflow-y-auto overflow-x-hidden bg-gray-300 p-2"
            >
              {paras.length === 0 && phase !== "done" && (
                <div className="p-4"><Skeleton /></div>
              )}
              {paras.map((para, idx) => {
                const isFirstOfPage = idx === 0 || paras[idx - 1].pageNum !== para.pageNum;
                return (
                  <div key={idx}>
                    {isFirstOfPage && (
                      <div style={{
                        fontSize: "11px", color: "#9ca3af",
                        fontFamily: "system-ui,sans-serif",
                        padding: "4px 10px",
                        margin: idx > 0 ? "10px 0 4px" : "0 0 4px",
                        background: "#e5e7eb", borderRadius: "4px",
                      }}>
                        第 {para.pageNum} 页
                      </div>
                    )}
                    <div style={{
                      marginBottom: 4,
                      background: "#f5f5f5",
                      borderLeft: "3px solid #d1d5db",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                      padding: "10px 16px",
                      fontFamily: '"Source Han Serif SC","Noto Serif SC","Songti SC",宋体,SimSun,serif',
                      fontSize: "13px", lineHeight: "1.75", color: "#555",
                    }}>
                      {para.status === "pending" && <Skeleton />}
                      {para.status === "translating" && (
                        <div>
                          <TranslationText text={para.translation} />
                          <span className="inline-block w-0.5 h-4 bg-amber-400 ml-0.5 align-middle animate-pulse" />
                        </div>
                      )}
                      {para.status === "done" && <TranslationText text={para.translation} />}
                      {para.status === "skipped" && (
                        <span style={{ fontFamily: "monospace", fontSize: "12px", color: "#9ca3af" }}>
                          {para.origText}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
