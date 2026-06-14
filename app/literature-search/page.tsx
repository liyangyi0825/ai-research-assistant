"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import type { AnalyzedPaper } from "@/app/api/papers/search/route";

interface KeywordCombination {
  keywordsEn: string;
  keywordsCn: string;
  description: string;
}

type SearchStatus = "idle" | "loading" | "done" | "error";
type SortBy = "stars" | "year";

// ── 小组件 ─────────────────────────────────────────────────────────────────

function DotLoader() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" />
    </span>
  );
}

function Stars({ n }: { n: number }) {
  const colors: Record<number, string> = { 5: "text-yellow-500", 4: "text-yellow-400", 3: "text-amber-400", 2: "text-gray-400", 1: "text-gray-300" };
  return (
    <span className={`text-sm ${colors[n] ?? "text-gray-300"}`}>
      {"★".repeat(n)}{"☆".repeat(5 - n)}
    </span>
  );
}

function searchUrl(db: string, keywords: string): string {
  const q = encodeURIComponent(keywords);
  switch (db) {
    case "scholar":  return `https://scholar.google.com/scholar?q=${q}`;
    case "cnki":     return `https://kns.cnki.net/kns8/defaultresult/index?kw=${q}`;
    case "semantic": return `https://www.semanticscholar.org/search?q=${q}&sort=Relevance`;
    case "arxiv":    return `https://arxiv.org/search/?searchtype=all&query=${q}`;
    case "pubmed":   return `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`;
    default: return "#";
  }
}

// ── 单篇论文卡片 ────────────────────────────────────────────────────────────

function PaperCard({ paper, topic }: { paper: AnalyzedPaper; topic: string }) {
  const authorStr = paper.authors.length > 0
    ? paper.authors.join(", ") + (paper.authors.length >= 4 ? " 等" : "")
    : "作者未知";

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 hover:border-blue-200 hover:shadow-sm transition-all">
      {/* 顶部：星级 + 年份 + 引用 */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Stars n={paper.stars} />
          <span className="text-xs text-gray-400">
            {paper.stars === 5 ? "高度相关" : paper.stars === 4 ? "较相关" : paper.stars === 3 ? "有关联" : paper.stars === 2 ? "弱相关" : "相关性低"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          {paper.year && <span>{paper.year}</span>}
          {paper.citationCount !== null && (
            <span className="bg-gray-100 rounded px-1.5 py-0.5">引用 {paper.citationCount}</span>
          )}
        </div>
      </div>

      {/* 标题 */}
      <h3 className="font-semibold text-gray-900 text-sm leading-snug mb-0.5">{paper.titleCn}</h3>
      <p className="text-xs text-gray-400 leading-relaxed mb-2 italic">{paper.title}</p>

      {/* 作者 */}
      <p className="text-xs text-gray-500 mb-2">{authorStr}</p>

      {/* 摘要 */}
      {paper.abstract && (
        <p className="text-xs text-gray-500 leading-relaxed mb-3 line-clamp-2">
          {paper.abstract.slice(0, 120)}{paper.abstract.length > 120 ? "…" : ""}
        </p>
      )}

      {/* AI 关联说明 */}
      <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 mb-3">
        <p className="text-xs text-blue-700 leading-relaxed">
          <span className="font-medium">🔗 与「{topic}」的关联：</span>
          {paper.relevanceNote}
        </p>
      </div>

      {/* 操作按钮 */}
      <div className="flex flex-wrap gap-2">
        <a
          href={searchUrl("cnki", paper.titleCn)}
          target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white text-xs rounded-lg transition-colors"
        >
          📚 知网搜索
        </a>
        <a
          href={searchUrl("scholar", paper.title)}
          target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-lg transition-colors"
        >
          🎓 Google Scholar
        </a>
        {paper.doi && (
          <a
            href={`https://doi.org/${paper.doi}`}
            target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1 border border-gray-200 hover:border-gray-400 bg-white text-gray-600 text-xs rounded-lg transition-colors"
          >
            DOI 原文
          </a>
        )}
        {paper.arxivId && (
          <a
            href={`https://arxiv.org/abs/${paper.arxivId}`}
            target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1 border border-gray-200 hover:border-gray-400 bg-white text-gray-600 text-xs rounded-lg transition-colors"
          >
            arXiv
          </a>
        )}
      </div>
    </div>
  );
}

// ── 搜索结果面板 ────────────────────────────────────────────────────────────

function SearchResults({
  papers,
  topic,
  sortBy,
  onSortChange,
}: {
  papers: AnalyzedPaper[];
  topic: string;
  sortBy: SortBy;
  onSortChange: (s: SortBy) => void;
}) {
  const sorted = [...papers].sort((a, b) =>
    sortBy === "stars"
      ? b.stars - a.stars || (b.year ?? 0) - (a.year ?? 0)
      : (b.year ?? 0) - (a.year ?? 0)
  );

  return (
    <div className="mt-3 space-y-3">
      {/* 排序工具栏 */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">找到 {papers.length} 篇相关论文</span>
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-400">排序：</span>
          {(["stars", "year"] as SortBy[]).map((s) => (
            <button
              key={s}
              onClick={() => onSortChange(s)}
              className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                sortBy === s
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
              }`}
            >
              {s === "stars" ? "相关性" : "时间"}
            </button>
          ))}
        </div>
      </div>

      {/* 论文列表 */}
      {sorted.map((paper) => (
        <PaperCard key={paper.paperId} paper={paper} topic={topic} />
      ))}
    </div>
  );
}

// ── 主页面 ─────────────────────────────────────────────────────────────────

export default function LiteratureSearchPage() {
  const [topic, setTopic] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [combinations, setCombinations] = useState<KeywordCombination[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // 每个检索词组合独立的搜索状态和结果
  const [searchStatus, setSearchStatus] = useState<Record<number, SearchStatus>>({});
  const [searchResults, setSearchResults] = useState<Record<number, AnalyzedPaper[]>>({});
  const [searchError, setSearchError] = useState<Record<number, string>>({});
  const [sortBy, setSortBy] = useState<SortBy>("stars");

  async function handleGenerate() {
    if (!topic.trim()) return;
    setStatus("loading");
    setErrorMsg("");
    setCombinations([]);
    setSearchStatus({});
    setSearchResults({});
    setSearchError({});

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

  async function handleAISearch(index: number, keywords: string) {
    setSearchStatus(prev => ({ ...prev, [index]: "loading" }));
    setSearchError(prev => ({ ...prev, [index]: "" }));

    try {
      const res = await fetch("/api/papers/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, topic }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "搜索失败");
      setSearchResults(prev => ({ ...prev, [index]: data.papers ?? [] }));
      setSearchStatus(prev => ({ ...prev, [index]: "done" }));
    } catch (err) {
      setSearchError(prev => ({ ...prev, [index]: err instanceof Error ? err.message : "搜索失败，请重试" }));
      setSearchStatus(prev => ({ ...prev, [index]: "error" }));
    }
  }

  function copyText(text: string, key: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
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
              输入研究课题，AI 生成中英双语检索词——可直接跳转，也可让 AI 精准搜索相关论文
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
              placeholder={"例如：钙钛矿太阳能电池界面工程\n例如：transformer for image classification"}
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
                {status === "loading"
                  ? <span className="flex items-center gap-2"><DotLoader /><span>生成中…</span></span>
                  : "生成检索词"}
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
                <span className="text-xs text-gray-400">点「AI 精准搜索」自动找相关论文</span>
              </div>

              {combinations.map((item, i) => (
                <div
                  key={i}
                  className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm border border-gray-100 hover:border-blue-200 transition-colors"
                >
                  {/* 序号 + 关键词 */}
                  <div className="flex items-start gap-3 mb-2">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center mt-0.5">
                      {i + 1}
                    </span>
                    <div className="flex-1 space-y-1.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-medium text-red-500 shrink-0">中</span>
                        <span className="text-sm font-medium text-gray-800 leading-relaxed">{item.keywordsCn}</span>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-medium text-blue-500 shrink-0">英</span>
                        <code className="text-xs font-mono text-gray-600 leading-relaxed break-all">{item.keywordsEn}</code>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-gray-400 ml-9 mb-3">{item.description}</p>

                  {/* 搜索按钮区域 */}
                  <div className="ml-9 space-y-2">
                    {/* 第一行：AI 精准搜索 + 主要数据库 */}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleAISearch(i, item.keywordsEn)}
                        disabled={searchStatus[i] === "loading"}
                        className="text-xs h-8 px-3 bg-violet-600 hover:bg-violet-700 text-white border-0"
                      >
                        {searchStatus[i] === "loading"
                          ? <span className="flex items-center gap-1.5"><DotLoader /><span>搜索中…</span></span>
                          : searchStatus[i] === "done"
                          ? "🤖 重新搜索"
                          : "🤖 AI 精准搜索"}
                      </Button>
                      <a
                        href={searchUrl("cnki", item.keywordsCn)}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        📚 知网 CNKI
                        <span className="opacity-70 text-[10px]">中文</span>
                      </a>
                      <a
                        href={searchUrl("scholar", item.keywordsEn)}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        🎓 Google Scholar
                        <span className="opacity-70 text-[10px]">英文</span>
                      </a>
                    </div>

                    {/* 第二行：次要数据库 */}
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={searchUrl("semantic", item.keywordsEn)}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 hover:border-gray-400 bg-white text-gray-600 hover:text-gray-800 text-xs font-medium rounded-lg transition-colors"
                      >
                        🔬 Semantic Scholar
                      </a>
                      <a
                        href={searchUrl("arxiv", item.keywordsEn)}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 hover:border-gray-400 bg-white text-gray-600 hover:text-gray-800 text-xs font-medium rounded-lg transition-colors"
                      >
                        📄 arXiv
                      </a>
                    </div>

                    {/* 第三行：PubMed + 复制 */}
                    <div className="flex items-center justify-between">
                      <a
                        href={searchUrl("pubmed", item.keywordsEn)}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
                      >
                        🧬 PubMed
                        <span className="text-gray-300 ml-0.5">· 生命科学/医学</span>
                      </a>
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => copyText(item.keywordsCn, `${i}-cn`)} className="text-xs h-7 px-2.5">
                          {copiedKey === `${i}-cn` ? "已复制 ✓" : "复制中文"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => copyText(item.keywordsEn, `${i}-en`)} className="text-xs h-7 px-2.5">
                          {copiedKey === `${i}-en` ? "已复制 ✓" : "复制英文"}
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* AI 搜索错误 */}
                  {searchStatus[i] === "error" && (
                    <div className="mt-3 ml-9 p-2 bg-red-50 border border-red-100 rounded-lg text-xs text-red-500">
                      ❌ {searchError[i]}
                    </div>
                  )}

                  {/* AI 搜索结果 */}
                  {searchStatus[i] === "done" && searchResults[i] && (
                    <div className="mt-3 ml-0 sm:ml-9">
                      {searchResults[i].length === 0 ? (
                        <p className="text-xs text-gray-400 py-2">未找到相关论文，请尝试其他组合</p>
                      ) : (
                        <SearchResults
                          papers={searchResults[i]}
                          topic={topic}
                          sortBy={sortBy}
                          onSortChange={setSortBy}
                        />
                      )}
                    </div>
                  )}
                </div>
              ))}

              <div className="bg-blue-50 rounded-xl p-4 text-sm text-blue-700 border border-blue-100">
                💡 <strong>使用技巧：</strong>点「🤖 AI 精准搜索」自动找最相关的 10 篇英文论文，AI 评估与你课题的关联度。知网按钮用中文关键词，Google Scholar 用英文关键词。
              </div>

              <Button variant="outline" className="w-full" onClick={handleGenerate}>
                重新生成检索词
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
