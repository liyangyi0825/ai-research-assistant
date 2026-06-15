"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";

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

// ── 段落类型 ───────────────────────────────────────────────────────────────
type ParaType = "heading" | "abstract" | "paragraph" | "reference";
interface Para { text: string; type: ParaType; }

// 判断是否为标题类行（数字编号、全大写、Abstract、References 等）
function looksLikeHeading(line: string): boolean {
  if (line.length >= 150) return false;
  if (line.length < 2) return false;
  // 全大写行：无小写字母、有大写字母、至少 6 字符（覆盖 INTRODUCTION / MATERIALS AND METHODS 等）
  const isAllCaps = !/[a-z]/.test(line) && /[A-Z]/.test(line) && line.length >= 6;
  return (
    /^abstract$/i.test(line) ||
    /^(references?|bibliography|works\s+cited)$/i.test(line) ||
    /^keywords?\s*:/i.test(line) ||              // Keywords: / Key Words:
    /^\d+\.[\d.]*\s+\S/.test(line) ||            // 1. Intro / 1.1 Methods
    /^\d+\s+[A-Z]/.test(line) ||                 // 1 Introduction（无点）
    /^[IVX]+\.\s+[A-Z]/.test(line) ||            // II. RELATED WORK
    isAllCaps                                     // 全大写标题
  );
}

// ── 把原文拆成带类型的段落 ──────────────────────────────────────────────────
// 按单个 \n 拆分，把连续非空行合并成段落块，
// 遇到标题行（数字编号/全大写）或空行则另起一块。
function splitIntoParagraphs(text: string): Para[] {
  const lines = text.split("\n").map(l => l.trim());
  const blocks: string[] = [];
  let current: string[] = [];

  function flush() {
    if (current.length === 0) return;
    blocks.push(current.join(" "));
    current = [];
  }

  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    if (looksLikeHeading(line)) {
      flush();           // 先把前面积累的段落保存
      blocks.push(line); // 标题单独成块
      continue;
    }
    current.push(line);
  }
  flush();

  // 分类 + 过滤页码等噪音
  const result: Para[] = [];
  let inRefs = false;

  for (const p of blocks) {
    if (p.length < 10) continue; // 太短 = 噪音

    const isRefsHeading = /^(references?|bibliography|works\s+cited)$/i.test(p);

    let type: ParaType;
    if (inRefs) {
      type = "reference";
    } else if (/^abstract$/i.test(p)) {
      type = "abstract";
    } else if (isRefsHeading) {
      type = "heading"; // "References" 标题本身翻译为"参考文献"
    } else if (looksLikeHeading(p)) {
      type = "heading";
    } else {
      type = "paragraph";
    }

    if (isRefsHeading) inRefs = true;
    result.push({ text: p, type });
  }

  return result.slice(0, 300);
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

const BATCH_SIZE = 4; // 每次调用 API 翻译的段落数

export function TranslationView({ extractedText, onBack, backLabel = "← 返回总结" }: Props) {
  const [paragraphs, setParagraphs]             = useState<Para[]>([]);
  const [translations, setTranslations]         = useState<string[]>([]);
  const [status, setStatus]                     = useState<"loading" | "streaming" | "done" | "error">("loading");
  const [error, setError]                       = useState("");
  const [progressDone, setProgressDone]         = useState(0);
  const [progressTotal, setProgressTotal]       = useState(0);
  // 当前正在流式输出的段落索引（-1 = 无）
  const [streamingParaIdx, setStreamingParaIdx] = useState(-1);

  const startTranslation = useCallback(async (paras: Para[]) => {
    setStatus("loading");
    setError("");
    setProgressDone(0);
    setStreamingParaIdx(-1);
    // 参考文献条目预填英文原文，其余初始化为空
    setTranslations(paras.map(p => p.type === "reference" ? p.text : ""));

    // 只翻译非参考文献段落
    const translatableIdxs: number[] = paras
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.type !== "reference")
      .map(({ i }) => i);

    setProgressTotal(translatableIdxs.length);

    if (translatableIdxs.length === 0) {
      setStatus("done");
      return;
    }

    // ── 翻译单批（BATCH_SIZE 段）────────────────────────────────────────
    async function translateBatch(batchIdxs: number[]): Promise<void> {
      const texts = batchIdxs.map(i => paras[i].text);
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paragraphs: texts }),
        signal: AbortSignal.timeout(30000), // 30 秒超时
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "翻译失败");
      }

      let accumulated = "";

      for await (const chunk of streamAnthropicSSE(res)) {
        accumulated += chunk;
        const parts = accumulated.split("[|||]");

        // 最后一个 part 对应当前正在流入的段落
        const lastApiIdx = Math.min(parts.length - 1, batchIdxs.length - 1);
        setStreamingParaIdx(batchIdxs[lastApiIdx] ?? -1);

        setTranslations(prev => {
          const next = [...prev];
          parts.forEach((part, apiIdx) => {
            const paraIdx = batchIdxs[apiIdx];
            if (paraIdx === undefined) return;
            // 已有后续分隔符 = 该段完成，trim；最后一段还在流入，不 trim
            next[paraIdx] = apiIdx < parts.length - 1 ? part.trim() : part;
          });
          return next;
        });
      }

      // 本批结束，trim 所有段落，清除流式指示器
      setTranslations(prev => {
        const next = [...prev];
        batchIdxs.forEach(i => { next[i] = (next[i] ?? "").trim(); });
        return next;
      });
      setStreamingParaIdx(-1);
    }

    // ── 循环翻译所有批次 ─────────────────────────────────────────────────
    setStatus("streaming");
    for (let b = 0; b < translatableIdxs.length; b += BATCH_SIZE) {
      const batchIdxs = translatableIdxs.slice(b, b + BATCH_SIZE);
      try {
        await translateBatch(batchIdxs);
      } catch (e) {
        // 这批失败 → 标记失败文字，继续下一批，不停止整体流程
        console.error("第", b / BATCH_SIZE + 1, "批翻译失败:", e);
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
    const paras = splitIntoParagraphs(extractedText);
    setParagraphs(paras);
    startTranslation(paras);
  }, [extractedText, startTranslation]);

  // 拼接所有非参考文献译文，供「复制全文翻译」使用
  const allTranslation = paragraphs
    .map((p, i) => (p.type !== "reference" && translations[i]?.trim()) ? translations[i].trim() : null)
    .filter(Boolean)
    .join("\n\n");

  // 计算摘要正文段落（Abstract 标题之后、下一个标题之前的普通段落）
  const abstractBodyIdxs = useMemo(() => {
    const idxs = new Set<number>();
    let inAbstract = false;
    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      if (p.type === "abstract") { inAbstract = true; continue; }
      if (inAbstract && (p.type === "heading" || p.type === "reference")) { inAbstract = false; }
      if (inAbstract && p.type === "paragraph") idxs.add(i);
    }
    return idxs;
  }, [paragraphs]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      {/* ── 顶部工具栏 ── */}
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <Button variant="outline" size="sm" onClick={onBack}>{backLabel}</Button>
          <span className="text-sm font-medium text-gray-700">📖 全文对照翻译</span>
          {status === "streaming" && (
            <span className="text-xs text-blue-500 bg-blue-50 px-2 py-0.5 rounded-full">
              正在翻译 第{Math.min(progressDone + 1, progressTotal)}段 / 共{progressTotal}段…
            </span>
          )}
          {status === "done" && (
            <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">✓ 翻译完成</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {allTranslation && <CopyBtn text={allTranslation} label="复制全文翻译" />}
            {status === "error" && (
              <Button size="sm" onClick={() => startTranslation(paragraphs)}>重试</Button>
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

        {paragraphs.length === 0 && status === "loading" && (
          <div className="p-12 text-center text-gray-400">
            <div className="text-3xl mb-3 animate-spin">⏳</div>
            <p>正在准备翻译…</p>
          </div>
        )}

        {paragraphs.length > 0 && (
          <div className="divide-y divide-gray-200 bg-white sm:rounded-xl overflow-hidden sm:shadow-sm">
            {paragraphs.map((para, i) => {
              const zh = translations[i] ?? "";
              const isHeadingType = para.type === "heading" || para.type === "abstract";
              const isRef = para.type === "reference";
              const isAbstractBody = abstractBodyIdxs.has(i);

              // 有内容且不是当前流式段落 → 已完成
              const isDone = !isRef && !!zh.trim() && i !== streamingParaIdx;
              // 当前正在流式输出
              const isActive = !isRef && i === streamingParaIdx && status === "streaming";

              return (
                <div
                  key={i}
                  className={`grid grid-cols-1 md:grid-cols-2 ${
                    isHeadingType
                      ? "border-l-4 border-l-blue-500 mt-2"
                      : isAbstractBody
                      ? "border-l-4 border-l-blue-200"
                      : isRef
                      ? "opacity-60"
                      : ""
                  }`}
                >
                  {/* 左：英文原文 */}
                  <div className={`px-4 py-3 md:border-r border-gray-100 leading-relaxed ${
                    isHeadingType
                      ? "font-bold text-gray-900 text-base bg-gray-50"
                      : isAbstractBody
                      ? "text-sm text-gray-700 bg-blue-50/30 pl-6"
                      : isRef
                      ? "text-xs text-gray-500 bg-gray-50"
                      : "text-sm text-gray-700 bg-blue-50/30"
                  }`}>
                    {!isHeadingType && !isRef && (
                      <span className="text-blue-300 text-xs mr-2 select-none">{i + 1}</span>
                    )}
                    {para.text}
                  </div>

                  {/* 右：中文译文 */}
                  <div className={`px-4 py-3 leading-relaxed relative group ${
                    isHeadingType
                      ? "font-bold text-gray-900 text-base bg-gray-50"
                      : isAbstractBody
                      ? "text-sm text-gray-800 bg-white pl-6"
                      : isRef
                      ? "text-xs text-gray-500 bg-white"
                      : "text-sm text-gray-800 bg-white"
                  }`}>
                    {isRef ? (
                      zh // 参考文献右侧显示英文原文
                    ) : isDone ? (
                      <>
                        {!isHeadingType && (
                          <span className="hidden group-hover:block absolute top-2 right-2">
                            <CopyBtn text={zh} />
                          </span>
                        )}
                        {zh}
                      </>
                    ) : isActive ? (
                      <>
                        {zh}
                        <span className="inline-block w-0.5 h-3.5 bg-amber-400 ml-0.5 align-middle animate-pulse" />
                      </>
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
