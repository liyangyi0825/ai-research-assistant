"use client";

import { useState, useEffect, useCallback } from "react";
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

interface Para {
  text: string;
  type: ParaType;
}

// ── 把原文拆成带类型的段落 ──────────────────────────────────────────────────
function splitIntoParagraphs(text: string): Para[] {
  const blocks = text.split(/\n{2,}/);
  const result: Para[] = [];
  let inRefs = false;

  for (const block of blocks) {
    const p = block.replace(/\n/g, " ").trim();
    if (!p) continue;

    const isRefsHeading = /^(references?|bibliography|works\s+cited)$/i.test(p);

    const isHeadingLike =
      p.length < 150 &&
      (
        /^abstract$/i.test(p) ||
        isRefsHeading ||
        /^(\d+\.[\d.]* +\S)/.test(p) ||        // 1. Introduction / 1.1 Methods
        /^[IVX]+\. +[A-Z]/.test(p) ||           // II. RELATED WORK
        /^[A-Z][A-Z\s\-:,]{5,}[A-Z]$/.test(p)  // ALL CAPS HEADING
      );

    // 过滤噪音（页码、页眉等）——但保留标题类短行
    if (p.length < 20 && !isHeadingLike) continue;

    let type: ParaType;
    if (inRefs) {
      type = "reference";
    } else if (/^abstract$/i.test(p)) {
      type = "abstract";
    } else if (isRefsHeading) {
      type = "heading"; // "References" 标题本身翻译成"参考文献"
    } else if (isHeadingLike) {
      type = "heading";
    } else {
      type = "paragraph";
    }

    // 遇到参考文献标题后，后续全部标记为 reference
    if (isRefsHeading) inRefs = true;

    result.push({ text: p, type });
  }

  return result.slice(0, 100);
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

export function TranslationView({ extractedText, onBack, backLabel = "← 返回总结" }: Props) {
  const [paragraphs, setParagraphs]     = useState<Para[]>([]);
  const [translations, setTranslations] = useState<string[]>([]);
  const [status, setStatus]             = useState<"loading" | "streaming" | "done" | "error">("loading");
  const [error, setError]               = useState("");

  const startTranslation = useCallback(async (paras: Para[]) => {
    setStatus("loading");
    setError("");

    // 参考文献条目直接保留英文原文，其余初始化为空字符串
    setTranslations(paras.map(p => p.type === "reference" ? p.text : ""));

    // 只把非参考文献段落发给 AI 翻译
    const translatableIdxs: number[] = paras
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.type !== "reference")
      .map(({ i }) => i);

    const toTranslate = translatableIdxs.map(i => paras[i].text);
    if (toTranslate.length === 0) {
      setStatus("done");
      return;
    }

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paragraphs: toTranslate }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "翻译失败");
      }

      setStatus("streaming");
      let accumulated = "";

      for await (const chunk of streamAnthropicSSE(res)) {
        accumulated += chunk;
        const parts = accumulated.split("[|||]");

        setTranslations(prev => {
          const next = [...prev];
          parts.forEach((part, apiIdx) => {
            const paraIdx = translatableIdxs[apiIdx];
            if (paraIdx !== undefined) {
              next[paraIdx] = apiIdx < parts.length - 1 ? part.trim() : part;
            }
          });
          return next;
        });
      }

      // 流结束后清理尾部空格（不动参考文献条目）
      setTranslations(prev =>
        prev.map((t, i) => (paras[i]?.type === "reference" ? t : t.trim()))
      );
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "翻译失败，请重试");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const paras = splitIntoParagraphs(extractedText);
    setParagraphs(paras);
    startTranslation(paras);
  }, [extractedText, startTranslation]);

  // 拼接非参考文献的译文供「复制全文」使用
  const allTranslation = paragraphs
    .map((p, i) => (p.type !== "reference" && translations[i]?.trim()) ? translations[i].trim() : null)
    .filter(Boolean)
    .join("\n\n");

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      {/* ── 顶部工具栏 ── */}
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <Button variant="outline" size="sm" onClick={onBack}>{backLabel}</Button>
          <span className="text-sm font-medium text-gray-700">📖 全文对照翻译</span>
          {status === "streaming" && (
            <span className="text-xs text-blue-500 bg-blue-50 px-2 py-0.5 rounded-full">翻译中…</span>
          )}
          {status === "done" && (
            <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">翻译完成</span>
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
            {(() => {
              // 计算当前正在流式输出的段落索引
              let streamingParaIdx = -1;
              if (status === "streaming") {
                for (let j = 0; j < paragraphs.length; j++) {
                  if (paragraphs[j]?.type !== "reference" && translations[j]) {
                    streamingParaIdx = j;
                  }
                }
              }

              return paragraphs.map((para, i) => {
                const zh = translations[i];
                const isHeadingType = para.type === "heading" || para.type === "abstract";
                const isRef = para.type === "reference";
                const isDone =
                  status === "done" ||
                  (!isRef && typeof zh === "string" && zh.trim().length > 0 && i < streamingParaIdx);
                const isActive = i === streamingParaIdx && !isRef;

                return (
                  <div
                    key={i}
                    className={`grid grid-cols-1 md:grid-cols-2 ${
                      isHeadingType
                        ? "border-l-4 border-l-blue-400"
                        : isRef
                        ? "opacity-60"
                        : ""
                    }`}
                  >
                    {/* 左：英文原文 */}
                    <div
                      className={`px-4 py-3 md:border-r border-gray-100 leading-relaxed ${
                        isHeadingType
                          ? "font-bold text-gray-900 text-[15px] bg-blue-50/80"
                          : isRef
                          ? "text-xs text-gray-500 bg-gray-50"
                          : "text-sm text-gray-700 bg-blue-50/30"
                      }`}
                    >
                      {!isHeadingType && !isRef && (
                        <span className="text-blue-300 text-xs mr-2 select-none">{i + 1}</span>
                      )}
                      {para.text}
                    </div>

                    {/* 右：中文译文 */}
                    <div
                      className={`px-4 py-3 leading-relaxed bg-white relative group ${
                        isHeadingType
                          ? "font-bold text-gray-900 text-[15px]"
                          : isRef
                          ? "text-xs text-gray-500"
                          : "text-sm text-gray-800"
                      }`}
                    >
                      {isRef ? (
                        // 参考文献右侧显示英文原文（不翻译）
                        zh
                      ) : isDone && zh ? (
                        <>
                          {!isHeadingType && (
                            <span className="hidden group-hover:block absolute top-2 right-2">
                              <CopyBtn text={zh} />
                            </span>
                          )}
                          {zh}
                        </>
                      ) : isActive && zh ? (
                        <>
                          {zh}
                          <span className="inline-block w-0.5 h-3.5 bg-amber-400 ml-0.5 align-middle animate-pulse" />
                        </>
                      ) : isHeadingType && zh ? (
                        zh
                      ) : isRef ? (
                        zh
                      ) : (
                        <Skeleton />
                      )}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </main>

      <footer className="text-center py-3 text-xs text-gray-400 border-t border-gray-200 bg-white/50 mt-4">
        专业术语已保留英文原文（括号标注）· 人名机构名保留英文 · 参考文献保留英文
      </footer>
    </div>
  );
}
