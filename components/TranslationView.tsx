"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";

// ── SSE 流解析（与 upload/page.tsx 相同的逻辑）────────────────────────────
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

// ── 把论文原文拆成段落 ────────────────────────────────────────────────────
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, " ").trim())
    .filter(p => p.length > 40)   // 过滤掉太短的行（页码、页眉等）
    .slice(0, 80);                 // 最多80段
}

// ── 骨架屏：翻译加载中 ───────────────────────────────────────────────────
function Skeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-3 bg-gray-200 rounded w-full" />
      <div className="h-3 bg-gray-200 rounded w-5/6" />
      <div className="h-3 bg-gray-200 rounded w-4/6" />
    </div>
  );
}

// ── 复制按钮 ─────────────────────────────────────────────────────────────
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

// ── 主组件 ───────────────────────────────────────────────────────────────
interface Props {
  extractedText: string;
  onBack: () => void;
  backLabel?: string;
}

export function TranslationView({ extractedText, onBack, backLabel = "← 返回总结" }: Props) {
  const [paragraphs, setParagraphs]     = useState<string[]>([]);
  const [translations, setTranslations] = useState<string[]>([]);
  const [status, setStatus]             = useState<"loading" | "streaming" | "done" | "error">("loading");
  const [error, setError]               = useState("");

  const startTranslation = useCallback(async (paras: string[]) => {
    setStatus("loading");
    setError("");
    setTranslations([]);

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paragraphs: paras }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "翻译失败");
      }

      setStatus("streaming");
      let accumulated = "";

      for await (const chunk of streamAnthropicSSE(res)) {
        accumulated += chunk;

        // 每次新 chunk 到来，按 [|||] 分割，更新已完成的段落译文
        const parts = accumulated.split("[|||]");
        setTranslations(
          parts.map((p, i) =>
            // 最后一段还没收到结束符，可能仍在流入，其余段落都完成了
            i < parts.length - 1 ? p.trim() : p
          )
        );
      }

      // 流结束后清理最后一段的首尾空格
      setTranslations(prev => prev.map(t => t.trim()));
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "翻译失败，请重试");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const paras = splitParagraphs(extractedText);
    setParagraphs(paras);
    startTranslation(paras);
  }, [extractedText, startTranslation]);

  // 拼接所有已完成的译文，供「复制全文翻译」使用
  const allTranslation = translations
    .filter((t, i) => i < paragraphs.length && t.trim())
    .join("\n\n");

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      {/* ── 顶部工具栏 ──────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <Button variant="outline" size="sm" onClick={onBack}>
            {backLabel}
          </Button>
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

      {/* ── 内容区 ─────────────────────────────────────────────────── */}
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
            {paragraphs.map((en, i) => {
              const zh = translations[i];
              const isDone   = status === "done" || (typeof zh === "string" && zh.trim() && i < translations.length - 1);
              const isActive = i === translations.length - 1 && status === "streaming";

              return (
                <div
                  key={i}
                  className="grid grid-cols-1 md:grid-cols-2"
                >
                  {/* 左：英文原文 */}
                  <div className="px-4 py-4 md:border-r border-gray-100 bg-blue-50/30 text-sm text-gray-700 leading-relaxed">
                    <span className="text-blue-300 text-xs mr-2 select-none">{i + 1}</span>
                    {en}
                  </div>

                  {/* 右：中文译文 */}
                  <div className="px-4 py-4 text-sm text-gray-800 leading-relaxed bg-white relative group">
                    {isDone && zh ? (
                      <>
                        <span className="hidden group-hover:block absolute top-2 right-2">
                          <CopyBtn text={zh} />
                        </span>
                        {zh}
                      </>
                    ) : isActive && zh ? (
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

      <footer className="text-center py-3 text-xs text-gray-400 border-t border-gray-200 bg-white/50 mt-4">
        专业术语已保留英文原文（括号标注）·　人名机构名保留英文
      </footer>
    </div>
  );
}
