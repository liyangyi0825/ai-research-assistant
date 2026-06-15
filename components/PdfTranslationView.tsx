"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

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

// ── 每页状态 ───────────────────────────────────────────────────────────────
type PageStatus = "pending" | "translating" | "done" | "error" | "empty";

interface PageState {
  canvasHeight: number; // CSS 像素高度，用于右侧对齐
  text: string;         // PDF.js 提取的原文
  translation: string;  // 流式翻译内容
  status: PageStatus;
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
}

export function PdfTranslationView({ file, onBack }: Props) {
  const [numPages, setNumPages]           = useState(0);
  const [renderedPages, setRenderedPages] = useState(0);
  const [pages, setPages]                 = useState<PageState[]>([]);
  const [transProgress, setTransProgress] = useState({ done: 0, total: 0 });
  const [phase, setPhase]                 = useState<"idle" | "rendering" | "translating" | "done">("idle");
  const [globalError, setGlobalError]     = useState("");
  const leftRef  = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  // ── 加载、渲染 PDF，然后逐页翻译 ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function run() {
      const container = leftRef.current;
      if (!container) return;
      container.innerHTML = "";
      setPages([]);
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

        // ── 第一阶段：渲染所有页面，同时提取文字 ─────────────────────────
        const initialPages: PageState[] = [];

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

          await page.render({ canvas, viewport }).promise;
          if (cancelled) break;

          // 提取文字
          const textContent = await page.getTextContent();
          const text = textContent.items
            .map(item => ("str" in item ? (item as { str: string }).str : ""))
            .join("");

          const pageState: PageState = {
            canvasHeight: cssH,
            text: text.trim(),
            translation: "",
            status: text.trim() ? "pending" : "empty",
          };
          initialPages.push(pageState);
          setPages([...initialPages]);
          setRenderedPages(pageNum);
        }

        if (cancelled) return;

        // ── 第二阶段：逐页翻译 ────────────────────────────────────────────
        const translatableCount = initialPages.filter(p => p.status === "pending").length;
        setTransProgress({ done: 0, total: translatableCount });
        setPhase("translating");

        let translatedCount = 0;
        let isFirst = true;

        for (let i = 0; i < initialPages.length; i++) {
          if (cancelled) break;
          if (initialPages[i].status !== "pending") continue;

          // 标记翻译中
          setPages(prev => {
            const next = [...prev];
            next[i] = { ...next[i], status: "translating" };
            return next;
          });

          try {
            const res = await fetch("/api/translate-page", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                pageNum: i + 1,
                text: initialPages[i].text,
                isFirst,
              }),
              signal: AbortSignal.timeout(120000),
            });

            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error((data as { error?: string }).error || "翻译失败");
            }

            isFirst = false; // 之后的页不再检查用量

            for await (const chunk of streamAnthropicSSE(res)) {
              if (cancelled) break;
              setPages(prev => {
                const next = [...prev];
                next[i] = { ...next[i], translation: next[i].translation + chunk };
                return next;
              });
            }

            setPages(prev => {
              const next = [...prev];
              next[i] = {
                ...next[i],
                status: "done",
                translation: next[i].translation.trim(),
              };
              return next;
            });
          } catch (e) {
            console.error(`第 ${i + 1} 页翻译失败:`, e);
            setPages(prev => {
              const next = [...prev];
              next[i] = { ...next[i], status: "error" };
              return next;
            });
            // 如果是第一页用量超限，直接停止
            if (isFirst && e instanceof Error && e.message.includes("次数已用完")) {
              setGlobalError(e.message);
              break;
            }
          }

          translatedCount++;
          setTransProgress({ done: translatedCount, total: translatableCount });
        }

        if (!cancelled) setPhase("done");
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
    if (phase === "translating") {
      return (
        <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
          正在翻译 第 {transProgress.done + 1} / {transProgress.total} 页…
        </span>
      );
    }
    if (phase === "done") {
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

      {/* ── 主内容（左 PDF / 右翻译） ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {/* 左：PDF 逐页渲染 */}
        <div
          ref={leftRef}
          className="w-1/2 overflow-y-auto overflow-x-hidden bg-gray-300 p-4"
        />

        {/* 右：逐页翻译 */}
        <div
          ref={rightRef}
          className="w-1/2 overflow-y-auto bg-white border-l border-gray-200"
        >
          {pages.map((page, i) => (
            <div
              key={i}
              // min-height 与左侧 canvas 高度对齐（+8 是左侧 margin-bottom）
              style={{ minHeight: page.canvasHeight + 8 }}
              className="px-5 py-4 border-b border-gray-100 text-sm leading-7 text-gray-800"
            >
              {page.status === "pending" && <Skeleton />}

              {page.status === "translating" && (
                <div className="whitespace-pre-wrap">
                  {page.translation}
                  <span className="inline-block w-0.5 h-4 bg-amber-400 ml-0.5 align-middle animate-pulse" />
                </div>
              )}

              {page.status === "done" && (
                <div className="whitespace-pre-wrap">{page.translation}</div>
              )}

              {page.status === "error" && (
                <span className="text-red-400 text-xs">第 {i + 1} 页翻译失败</span>
              )}

              {page.status === "empty" && (
                <span className="text-gray-300 text-xs">（此页无文字内容）</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
