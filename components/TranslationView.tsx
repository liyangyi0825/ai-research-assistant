"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { TranslationText } from "@/components/PdfTranslationView";

// ── SSE 流解析 ─────────────────────────────────────────────────────────────
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

// ── 数学公式保护（防止翻译 API 破坏公式）────────────────────────────────────
// 占位符使用罕见 Unicode 角括号，避免与正文冲突
const MATH_PLACEHOLDER_RE = /⟨MATH_(\d+)⟩/g;

function extractMathFormulas(text: string): { maskedText: string; formulas: string[] } {
  const formulas: string[] = [];
  // 匹配顺序：$$..$$（多行）→ $..$ → \[..\] → \(..\) → 裸 LaTeX 命令块（含花括号或上下标）
  const mathRe =
    /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?:\\[a-zA-Z]+(?:\{[^}]*\}|\[[^\]]*\])*(?:[_^]\{[^}]*\})*)+)/g;
  const maskedText = text.replace(mathRe, (match) => {
    // 跳过不像公式的单词命令（如 \n \t）
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

// ── 块类型 ─────────────────────────────────────────────────────────────────
type ChunkType = "heading" | "paragraph" | "reference";
interface Chunk { text: string; type: ChunkType; }

// 判断一段文本是否像章节标题
function isHeadingText(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t.length > 200) return false;
  // 常见独立关键词（大小写不限）
  if (/^(abstract|keywords?|references?|bibliography|acknowledgements?|notation|appendix)\.?$/i.test(t)) return true;
  // 数字编号：1 Introduction / 2.1 Methods / 3.2.1 Analysis
  if (/^\d+(\.\d+)*[\s.]\s*[A-Z一-鿿]/.test(t) && t.length < 120) return true;
  // 罗马数字：II. RELATED WORK（[1IVX] 兼容 OCR 将大写 I 误识别为数字 1 的情况）
  if (/^[1IVX]+\.\s+[A-Z]/.test(t) && t.length < 120) return true;
  // 单词全大写（INTRODUCTION / CONCLUSIONS 等）
  const words = t.split(/\s+/);
  if (words.length === 1 && /^[A-Z]{4,}$/.test(t)) return true;
  // 多词全大写（MATERIALS AND METHODS 等）
  if (words.length >= 2 && words.length <= 10 && !/[a-z]/.test(t) && /[A-Z]/.test(t) && t.length >= 4) return true;
  return false;
}

function isReferencesStart(s: string): boolean {
  return /^(references?|bibliography|works\s+cited)\.?$/i.test(s.trim());
}

// ── 句子切分（正文内容使用） ────────────────────────────────────────────────
// 按句子结尾（。？！ 以及后跟空格的 .?!）切句，每 3-5 句或 400-600 字符一块
function sentenceChunks(body: string): string[] {
  if (!body.trim()) return [];

  const marked = body.replace(/([。？！]|[.?!](?=\s))/g, "$1\n");
  const sentences = marked.split("\n").map(s => s.trim()).filter(s => s.length > 0);

  const result: string[] = [];
  let cur = "";
  let count = 0;

  for (const sent of sentences) {
    // 超长无标点大块 → 按空格强制切到 600 字符以内
    if (sent.length > 600) {
      if (cur) { result.push(cur); cur = ""; count = 0; }
      let rem = sent;
      while (rem.length > 600) {
        let cut = 600;
        while (cut > 400 && rem[cut] !== " ") cut--;
        if (cut <= 400) cut = 600;
        result.push(rem.slice(0, cut).trim());
        rem = rem.slice(cut).trim();
      }
      if (rem) { cur = rem; count = 1; }
      continue;
    }

    cur += (cur ? " " : "") + sent;
    count++;

    const flush = (count >= 3 && cur.length >= 400) || count >= 5 || cur.length >= 600;
    if (flush) { result.push(cur); cur = ""; count = 0; }
  }
  if (cur.trim()) result.push(cur.trim());
  return result;
}

// ── 智能分块主函数 ─────────────────────────────────────────────────────────
// 先按 \n 拆行，标题独立成块，正文按句子切分，参考文献单独标记
function smartChunk(text: string): Chunk[] {
  const rawLines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);

  const result: Chunk[] = [];
  let inRefs = false;
  let bodyBuf = "";

  function flushBody() {
    if (!bodyBuf.trim()) return;
    const type: ChunkType = inRefs ? "reference" : "paragraph";
    for (const c of sentenceChunks(bodyBuf)) {
      result.push({ text: c, type });
    }
    bodyBuf = "";
  }

  for (const line of rawLines) {
    if (isHeadingText(line)) {
      flushBody();
      result.push({ text: line, type: "heading" });
      if (isReferencesStart(line)) inRefs = true;
    } else {
      bodyBuf += (bodyBuf ? " " : "") + line;
    }
  }
  flushBody();

  return result.slice(0, 500);
}

// ── 骨架屏 ─────────────────────────────────────────────────────────────────
function Skeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-3 bg-gray-200 rounded w-full" />
      <div className="h-3 bg-gray-200 rounded w-5/6" />
      <div className="h-3 bg-gray-200 rounded w-4/6" />
    </div>
  );
}

// ── 复制按钮 ──────────────────────────────────────────────────────────────
function CopyBtn({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }
  return (
    <button
      onClick={handleCopy}
      className="text-xs text-gray-400 hover:text-blue-500 transition-colors px-2 py-0.5 rounded hover:bg-blue-50 border border-transparent hover:border-blue-200"
    >
      {copied ? "已复制 ✓" : label}
    </button>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────
interface Props {
  extractedText: string;
  onBack: () => void;
  backLabel?: string;
}

const BATCH_SIZE = 3;

export function TranslationView({ extractedText, onBack, backLabel = "← 返回总结" }: Props) {
  const [chunks, setChunks]               = useState<Chunk[]>([]);
  const [translations, setTranslations]   = useState<string[]>([]);
  const [status, setStatus]               = useState<"loading" | "streaming" | "done" | "error">("loading");
  const [error, setError]                 = useState("");
  const [progressDone, setProgressDone]   = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [streamingIdx, setStreamingIdx]   = useState(-1);

  const startTranslation = useCallback(async (allChunks: Chunk[]) => {
    setStatus("loading");
    setError("");
    setProgressDone(0);
    setStreamingIdx(-1);
    // 参考文献预填原文，其余初始化为空
    setTranslations(allChunks.map(c => c.type === "reference" ? c.text : ""));

    const translatableIdxs = allChunks
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.type !== "reference")
      .map(({ i }) => i);

    setProgressTotal(translatableIdxs.length);

    if (translatableIdxs.length === 0) {
      setStatus("done");
      return;
    }

    // ── 翻译单批 ──────────────────────────────────────────────────────────
    async function translateBatch(batchIdxs: number[]): Promise<void> {
      // 发送前提取公式，替换为占位符，翻译完成后还原
      const extracted = batchIdxs.map(i => extractMathFormulas(allChunks[i].text));
      const texts = extracted.map(e => e.maskedText);

      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paragraphs: texts }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "翻译失败");
      }

      let accumulated = "";
      for await (const chunk of streamAnthropicSSE(res)) {
        accumulated += chunk;
        const parts = accumulated.split("[|||]");
        const lastApiIdx = Math.min(parts.length - 1, batchIdxs.length - 1);
        setStreamingIdx(batchIdxs[lastApiIdx] ?? -1);

        setTranslations(prev => {
          const next = [...prev];
          parts.forEach((part, apiIdx) => {
            const idx = batchIdxs[apiIdx];
            if (idx === undefined) return;
            // 流式阶段先显示含占位符的中间状态，完成后还原
            next[idx] = apiIdx < parts.length - 1 ? part.trim() : part;
          });
          return next;
        });
      }

      // 流结束后还原公式占位符
      setTranslations(prev => {
        const next = [...prev];
        batchIdxs.forEach((i, apiIdx) => {
          const raw = (next[i] ?? "").trim();
          next[i] = restoreMathFormulas(raw, extracted[apiIdx].formulas);
        });
        return next;
      });
      setStreamingIdx(-1);
    }

    // ── 循环翻译所有批次，失败则标记继续 ──────────────────────────────────
    setStatus("streaming");
    for (let b = 0; b < translatableIdxs.length; b += BATCH_SIZE) {
      const batchIdxs = translatableIdxs.slice(b, b + BATCH_SIZE);
      try {
        await translateBatch(batchIdxs);
      } catch (e) {
        console.error("第", Math.floor(b / BATCH_SIZE) + 1, "批翻译失败:", e);
        setTranslations(prev => {
          const next = [...prev];
          batchIdxs.forEach(idx => { next[idx] = "【翻译失败，请刷新页面重试】"; });
          return next;
        });
      }
      setProgressDone(b + batchIdxs.length);
    }
    setStatus("done");
  }, []);

  useEffect(() => {
    const allChunks = smartChunk(extractedText);
    setChunks(allChunks);
    startTranslation(allChunks);
  }, [extractedText, startTranslation]);

  const allTranslation = useMemo(() =>
    chunks
      .map((c, i) => (c.type !== "reference" && translations[i]?.trim()) ? translations[i].trim() : null)
      .filter(Boolean)
      .join("\n\n"),
    [chunks, translations]
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      {/* ── 顶部工具栏 ── */}
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <Button variant="outline" size="sm" onClick={onBack}>{backLabel}</Button>
          <span className="text-sm font-medium text-gray-700">📖 全文对照翻译</span>
          {status === "streaming" && (
            <span className="text-xs text-blue-500 bg-blue-50 px-2 py-0.5 rounded-full">
              正在翻译 第{Math.min(progressDone + 1, progressTotal)}块 / 共{progressTotal}块…
            </span>
          )}
          {status === "done" && (
            <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">✓ 翻译完成</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {allTranslation && <CopyBtn text={allTranslation} label="复制全文翻译" />}
            {status === "error" && (
              <Button size="sm" onClick={() => startTranslation(chunks)}>重试</Button>
            )}
          </div>
        </div>
        {/* 列标题 */}
        <div className="max-w-6xl mx-auto px-4 hidden md:grid md:grid-cols-2 gap-px bg-gray-200">
          <div className="bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-700 uppercase tracking-wide">English 原文</div>
          <div className="bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-700 uppercase tracking-wide">中文译文</div>
        </div>
      </div>

      {/* ── 内容区 ── */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-0 sm:px-4 py-0 sm:py-4">
        {status === "error" && (
          <div className="m-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">
            ❌ {error}
          </div>
        )}

        {chunks.length === 0 && status === "loading" && (
          <div className="p-12 text-center text-gray-400">
            <div className="text-3xl mb-3 animate-spin">⏳</div>
            <p>正在准备翻译…</p>
          </div>
        )}

        {chunks.length > 0 && (
          <div className="divide-y divide-gray-200 bg-white sm:rounded-xl overflow-hidden sm:shadow-sm">
            {chunks.map((chunk, i) => {
              const zh = translations[i] ?? "";
              const isHeading = chunk.type === "heading";
              const isRef = chunk.type === "reference";
              const isDone = isRef || (!!zh.trim() && i !== streamingIdx);
              const isActive = !isRef && i === streamingIdx && status === "streaming";

              // ── 标题行 ──
              if (isHeading) {
                return (
                  <div key={i} className="grid grid-cols-1 md:grid-cols-2 bg-gray-50 border-l-4 border-l-blue-500 mt-1">
                    <div className="px-4 py-3 md:border-r border-gray-200 font-bold text-gray-900 text-base leading-snug">
                      {chunk.text}
                    </div>
                    <div className="px-4 py-3 font-bold text-gray-900 text-base leading-snug">
                      {isDone
                        ? <TranslationText text={zh} />
                        : isActive
                        ? <>{zh}<span className="inline-block w-0.5 h-4 bg-amber-400 ml-0.5 align-middle animate-pulse" /></>
                        : <Skeleton />}
                    </div>
                  </div>
                );
              }

              // ── 参考文献行 ──
              if (isRef) {
                return (
                  <div key={i} className="grid grid-cols-1 md:grid-cols-2 opacity-60">
                    <div className="px-4 py-2 md:border-r border-gray-100 text-xs text-gray-500 bg-gray-50 leading-relaxed">
                      {chunk.text}
                    </div>
                    <div className="px-4 py-2 text-xs text-gray-500 bg-white leading-relaxed">
                      {zh}
                    </div>
                  </div>
                );
              }

              // ── 正文段落 ──
              return (
                <div key={i} className="grid grid-cols-1 md:grid-cols-2">
                  <div className="px-4 py-3 md:border-r border-gray-100 text-sm text-gray-700 bg-blue-50/30 leading-relaxed">
                    <span className="text-blue-300 text-xs mr-2 select-none">{i + 1}</span>
                    {chunk.text}
                  </div>
                  <div className="px-4 py-3 text-sm text-gray-800 bg-white leading-relaxed relative group">
                    {isDone ? (
                      <>
                        <span className="hidden group-hover:block absolute top-2 right-2">
                          <CopyBtn text={zh} />
                        </span>
                        <TranslationText text={zh} />
                      </>
                    ) : isActive ? (
                      <>{zh}<span className="inline-block w-0.5 h-3.5 bg-amber-400 ml-0.5 align-middle animate-pulse" /></>
                    ) : (
                      <Skeleton />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
