"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";

interface KeywordCombination {
  keywords: string;
  description: string;
}

// 三点加载动画
function DotLoader() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" />
    </span>
  );
}

export default function LiteratureSearchPage() {
  const [topic, setTopic] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [combinations, setCombinations] = useState<KeywordCombination[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  async function handleGenerate() {
    if (!topic.trim()) return;
    setStatus("loading");
    setErrorMsg("");
    setCombinations([]);

    try {
      const res = await fetch("/api/keywords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "生成失败");
      setCombinations(data.combinations);
      setStatus("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "生成失败，请重试");
      setStatus("error");
    }
  }

  function copyKeywords(keywords: string, index: number) {
    navigator.clipboard.writeText(keywords).catch(() => {});
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  }

  // 各数据库搜索链接生成
  function searchUrl(db: string, keywords: string): string {
    const q = encodeURIComponent(keywords);
    switch (db) {
      case "scholar":   return `https://scholar.google.com/scholar?q=${q}`;
      case "cnki":      return `https://kns.cnki.net/kns8/defaultresult/index?kw=${q}`;
      case "semantic":  return `https://www.semanticscholar.org/search?q=${q}&sort=Relevance`;
      case "arxiv":     return `https://arxiv.org/search/?searchtype=all&query=${q}`;
      case "pubmed":    return `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`;
      default: return "#";
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="文献检索" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-12 pb-24 sm:pb-12">
        <div className="w-full max-w-3xl space-y-4 sm:space-y-6">

          {/* 标题 */}
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">🔍 检索词矩阵生成</h1>
            <p className="text-sm sm:text-base text-gray-500">
              输入你的研究课题，AI 自动生成 8-10 个精准英文检索词组合，覆盖各个研究方向
            </p>
          </div>

          {/* 输入区域 */}
          <div className="bg-white rounded-2xl p-5 sm:p-6 shadow-sm border border-gray-100">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              研究课题（中英文均可）
            </label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate();
              }}
              placeholder="例如：深度学习在医学图像分割中的应用&#10;例如：transformer for image classification"
              rows={3}
              className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none leading-relaxed"
            />
            <div className="flex items-center justify-between mt-3">
              <span className="text-xs text-gray-400">Ctrl/Cmd + Enter 快速生成</span>
              <Button
                onClick={handleGenerate}
                disabled={!topic.trim() || status === "loading"}
                size="lg"
                className="px-6"
              >
                {status === "loading" ? (
                  <span className="flex items-center gap-2"><DotLoader /><span>生成中…</span></span>
                ) : "生成检索词"}
              </Button>
            </div>
          </div>

          {/* 错误提示 */}
          {status === "error" && (
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-red-100">
              <p className="text-red-500 text-sm">❌ {errorMsg}</p>
            </div>
          )}

          {/* 结果列表 */}
          {status === "done" && combinations.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base sm:text-lg font-bold text-gray-800">
                  📋 共生成 {combinations.length} 个检索词组合
                </h2>
                <span className="text-xs text-gray-400">点击按钮直接跳转或复制</span>
              </div>

              {combinations.map((item, i) => (
                <div
                  key={i}
                  className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm border border-gray-100 hover:border-blue-200 transition-colors"
                >
                  {/* 序号 + 关键词 */}
                  <div className="flex items-start gap-3 mb-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center mt-0.5">
                      {i + 1}
                    </span>
                    <code className="flex-1 text-sm sm:text-base font-mono text-gray-800 leading-relaxed break-all">
                      {item.keywords}
                    </code>
                  </div>

                  {/* 中文说明 */}
                  <p className="text-sm text-gray-500 ml-9 mb-3">{item.description}</p>

                  {/* 操作按钮 */}
                  <div className="ml-9 space-y-2">

                    {/* 主要数据库 */}
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={searchUrl("scholar", item.keywords)}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        🎓 Google Scholar
                      </a>
                      <a
                        href={searchUrl("cnki", item.keywords)}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        📚 知网 CNKI
                      </a>
                    </div>

                    {/* 次要数据库 */}
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={searchUrl("semantic", item.keywords)}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 hover:border-gray-400 bg-white text-gray-600 hover:text-gray-800 text-xs font-medium rounded-lg transition-colors"
                      >
                        🔬 Semantic Scholar
                      </a>
                      <a
                        href={searchUrl("arxiv", item.keywords)}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 hover:border-gray-400 bg-white text-gray-600 hover:text-gray-800 text-xs font-medium rounded-lg transition-colors"
                      >
                        📄 arXiv
                      </a>
                    </div>

                    {/* PubMed（折叠式，生命科学/医学专用）+ 复制 */}
                    <div className="flex items-center justify-between">
                      <a
                        href={searchUrl("pubmed", item.keywords)}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
                      >
                        🧬 PubMed
                        <span className="text-gray-300 ml-0.5">· 生命科学/医学</span>
                      </a>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copyKeywords(item.keywords, i)}
                        className="text-xs h-7 min-w-[64px]"
                      >
                        {copiedIndex === i ? "已复制 ✓" : "复制"}
                      </Button>
                    </div>

                  </div>
                </div>
              ))}

              {/* 底部提示 */}
              <div className="bg-blue-50 rounded-xl p-4 text-sm text-blue-700 border border-blue-100">
                💡 <strong>使用技巧：</strong>可以把多个组合分批搜索，覆盖面更全。在 Google Scholar 里还可以进一步筛选时间范围和引用数。
              </div>

              {/* 重新生成 */}
              <Button variant="outline" className="w-full" onClick={handleGenerate}>
                重新生成
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
