"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { MarkdownContent } from "@/components/MarkdownContent";
import { ContextChat } from "@/components/ContextChat";
import { toast } from "sonner";

// ─── 类型定义 ────────────────────────────────────────────────────────────────

interface Paper {
  paperId: string;
  title: string;
  authors: string;
  year: number | null;
  abstract: string | null;
  citationCount: number;
  doi: string | null;
  url: string | null;
  relevanceSummary?: string;
}

type Status = "idle" | "loading" | "done" | "error";
type SaveStatus = "idle" | "saving" | "saved" | "error";

// ─── 工具函数 ────────────────────────────────────────────────────────────────

async function* streamSSE(response: Response): AsyncGenerator<string> {
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
        if (!line.trim().startsWith("data: ")) continue;
        const data = line.trim().slice(6);
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
            yield parsed.delta.text;
          }
        } catch { /* 跳过 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}


// ─── 子组件 ──────────────────────────────────────────────────────────────────

function Skeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="space-y-2.5 animate-pulse">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3.5 bg-gray-200 rounded-full"
          style={{ width: `${85 - i * 8}%` }}
        />
      ))}
    </div>
  );
}

function BlockWrapper({
  title, icon, borderColor, status, children,
}: {
  title: string;
  icon: string;
  borderColor: string;
  status: Status;
  children: React.ReactNode;
}) {
  if (status === "idle") return null;

  return (
    <div className={`bg-white rounded-2xl shadow-sm border-l-4 ${borderColor} border border-gray-100 overflow-hidden`}>
      <div className="px-4 sm:px-6 py-3 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          <span>{icon}</span>
          <span className="text-sm sm:text-base">{title}</span>
          {status === "loading" && (
            <span className="text-xs font-normal text-gray-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" />
            </span>
          )}
        </h2>
      </div>
      <div className="p-4 sm:p-6">{children}</div>
    </div>
  );
}

function PaperCard({ paper, index }: { paper: Paper; index: number }) {
  const q = encodeURIComponent(paper.title);
  return (
    <div className="border border-gray-100 rounded-xl p-3 sm:p-4 hover:border-gray-200 transition-colors">
      <div className="flex items-start gap-2 mb-1.5">
        <span className="shrink-0 text-xs font-bold text-gray-400 mt-0.5">#{index + 1}</span>
        <div className="flex-1 min-w-0">
          {paper.url ? (
            <a
              href={paper.url}
              target="_blank" rel="noopener noreferrer"
              className="text-sm font-medium text-gray-800 leading-snug hover:text-blue-600 hover:underline"
            >
              {paper.title}
            </a>
          ) : (
            <p className="text-sm font-medium text-gray-800 leading-snug">{paper.title}</p>
          )}
          <p className="text-xs text-gray-500 mt-0.5">
            {paper.authors}
            {paper.year && <span className="ml-2 text-gray-400">{paper.year}</span>}
            {paper.citationCount > 0 && (
              <span className="ml-2 text-gray-400">引用 {paper.citationCount}</span>
            )}
          </p>
        </div>
      </div>
      {paper.abstract && (
        <p className="text-xs text-gray-500 ml-5 mb-2 leading-relaxed line-clamp-2">
          {paper.abstract.slice(0, 120)}…
        </p>
      )}
      {paper.relevanceSummary && (
        <p className="text-[11px] text-gray-400 ml-5 mb-2 leading-relaxed">
          🔗 {paper.relevanceSummary}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5 ml-5">
        <a
          href={`https://scholar.google.com/scholar?q=${q}`}
          target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-600 text-xs rounded-lg transition-colors"
        >
          🎓 Google Scholar
        </a>
        <a
          href={`https://kns.cnki.net/kns8/defaultresult/index?kw=${encodeURIComponent(paper.title)}`}
          target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-2 py-1 bg-red-50 hover:bg-red-100 text-red-600 text-xs rounded-lg transition-colors"
        >
          📚 知网
        </a>
        {paper.doi && (
          <a
            href={`https://doi.org/${paper.doi}`}
            target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-1 bg-gray-50 hover:bg-gray-100 text-gray-500 text-xs rounded-lg transition-colors"
          >
            🔗 DOI
          </a>
        )}
      </div>
    </div>
  );
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export default function ConceptExplorerPage() {
  const [concept, setConcept] = useState("");
  const [isExploring, setIsExploring] = useState(false);
  const [currentConcept, setCurrentConcept] = useState("");
  const autoTriggered = useRef(false);
  const [showRestoreBanner, setShowRestoreBanner] = useState(false);

  const STORAGE_KEY = "iyanhub_concept";
  const SEVEN_DAYS  = 7 * 24 * 60 * 60 * 1000;

  // 区块 1：概念溯源
  const [originAI, setOriginAI]           = useState("");
  const [originAIStatus, setOriginAIStatus] = useState<Status>("idle");
  const [oldestPapers, setOldestPapers]   = useState<Paper[]>([]);
  const [oldestStatus, setOldestStatus]   = useState<Status>("idle");

  // 区块 2：最新进展
  const [recentPapers, setRecentPapers]   = useState<Paper[]>([]);
  const [recentStatus, setRecentStatus]   = useState<Status>("idle");
  const [recentSearchTerm, setRecentSearchTerm] = useState(""); // 实际用于搜索的英文词

  // 区块 3：关联概念
  const [conceptsAI, setConceptsAI]         = useState("");
  const [conceptsStatus, setConceptsStatus] = useState<Status>("idle");

  // 区块 4：研究思路
  const [ideasAI, setIdeasAI]           = useState("");
  const [ideasStatus, setIdeasStatus]   = useState<Status>("idle");

  // 用 ref 持有最新保存函数，避免 setInterval 闭包陈旧
  const saveLatestRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveLatestRef.current = () => {
      if (!currentConcept) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          concept, currentConcept, originAI, oldestPapers, recentPapers, recentSearchTerm, conceptsAI, ideasAI,
          timestamp: Date.now(),
        }));
      } catch { /* 静默 */ }
    };
  }, [concept, currentConcept, originAI, oldestPapers, recentPapers, recentSearchTerm, conceptsAI, ideasAI]);

  // 探索中每 2 秒保存一次当前内容
  useEffect(() => {
    if (!isExploring) return;
    const timer = setInterval(() => saveLatestRef.current(), 2000);
    return () => clearInterval(timer);
  }, [isExploring]);

  // 探索完成后立即保存完整结果
  useEffect(() => {
    if (!isExploring) saveLatestRef.current();
  }, [isExploring]);

  // ── 保存到 Supabase 状态 ──
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null);

  // 各区块独立的保存状态
  const [blockSaveStatus, setBlockSaveStatus] = useState<Record<string, "idle" | "saving" | "saved" | "error">>({});

  // 保存单个区块内容
  async function handleSaveBlock(blockLabel: string, content: string) {
    if (blockSaveStatus[blockLabel] === "saving" || blockSaveStatus[blockLabel] === "saved") return;
    setBlockSaveStatus(prev => ({ ...prev, [blockLabel]: "saving" }));
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept:        `${currentConcept} · ${blockLabel}`,
          origin_summary: content,
          source_type:    "concept",
          source_id:      null,
          source_title:   currentConcept,
        }),
      });
      if (!res.ok) throw new Error();
      setBlockSaveStatus(prev => ({ ...prev, [blockLabel]: "saved" }));
      toast.success("已保存到研究笔记");
    } catch {
      setBlockSaveStatus(prev => ({ ...prev, [blockLabel]: "error" }));
      toast.error("保存失败，请重试");
    }
  }

  // 保存完整探索结果
  async function handleSaveNote() {
    if (saveStatus === "saving") return;
    setSaveStatus("saving");
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept:          currentConcept,
          origin_summary:   originAI   || null,
          latest_papers:    recentPapers.length ? recentPapers : null,
          related_concepts: conceptsAI || null,
          research_ideas:   ideasAI    || null,
          source_type:      "concept",
          source_id:        null,
          source_title:     currentConcept,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "保存失败");
      setSavedNoteId(data.id);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }

  // 使用 ref 收集最终文本（供后续区块使用）
  const originTextRef   = useRef("");
  const conceptsTextRef = useRef("");

  function resetAll() {
    setOriginAI(""); setOriginAIStatus("idle");
    setOldestPapers([]); setOldestStatus("idle");
    setRecentPapers([]); setRecentStatus("idle");
    setConceptsAI(""); setConceptsStatus("idle");
    setIdeasAI(""); setIdeasStatus("idle");
    setRecentSearchTerm("");
    setSaveStatus("idle");
    setSavedNoteId(null);
    setBlockSaveStatus({});
    originTextRef.current = "";
    conceptsTextRef.current = "";
  }

  // 注意：所有 API 调用都接受 term 参数，不依赖 currentConcept state（state 更新是异步的，直接用 term 变量保证正确性）
  async function fetchPapers(term: string, type: "oldest" | "recent"): Promise<Paper[]> {
    const res = await fetch("/api/concept-explorer/papers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concept: term, type }),
    });
    const data = await res.json();
    // 保存实际的英文搜索词（中文翻译后的结果）
    if (type === "recent" && data.searchTerm) setRecentSearchTerm(data.searchTerm);
    return data.papers ?? [];
  }

  // 给一批真实论文各配一句 AI 生成的关联说明（非流式，失败时原样返回不影响论文展示）
  async function fetchRelevanceSummaries(term: string, papers: Paper[]): Promise<Paper[]> {
    try {
      const res = await fetch("/api/concept-explorer/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: term, block: 2, papers }),
      });
      if (!res.ok) return papers;
      const data = await res.json();
      const summaries: string[] = data.summaries ?? [];
      return papers.map((p, i) => ({ ...p, relevanceSummary: summaries[i] || undefined }));
    } catch {
      return papers;
    }
  }

  async function streamBlock(
    term: string,
    block: number,
    papers: Paper[],
    setText: (t: string) => void,
    setStatus: (s: Status) => void,
    textRef: React.MutableRefObject<string>,
  ) {
    setStatus("loading");
    try {
      const res = await fetch("/api/concept-explorer/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept: term,
          block,
          papers,
          originText:   originTextRef.current,
          conceptsText: conceptsTextRef.current,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "AI 分析失败");
      }

      let full = "";
      for await (const chunk of streamSSE(res)) {
        full += chunk;
        textRef.current = full;
        setText(full);
      }
      setStatus("done");
    } catch (err) {
      console.error(`区块 ${block} 失败:`, err);
      setStatus("error");
    }
  }

  // 支持 /concept-explorer?q=xxx 直接跳转；否则从 localStorage 恢复
  useEffect(() => {
    if (autoTriggered.current) return;
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) {
      autoTriggered.current = true;
      setConcept(q);
      setTimeout(() => {
        document.getElementById("explore-btn")?.click();
      }, 50);
      return;
    }
    // 从 localStorage 恢复
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const data = JSON.parse(saved) as {
        concept?: string; currentConcept?: string;
        originAI?: string; oldestPapers?: Paper[]; recentPapers?: Paper[];
        recentSearchTerm?: string; conceptsAI?: string; ideasAI?: string;
        timestamp?: number;
      };
      if (!data.timestamp || Date.now() - data.timestamp > SEVEN_DAYS) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      if (data.concept)        setConcept(data.concept);
      if (data.currentConcept) setCurrentConcept(data.currentConcept);
      if (data.originAI)       { setOriginAI(data.originAI); setOriginAIStatus("done"); originTextRef.current = data.originAI; }
      if (data.oldestPapers?.length) { setOldestPapers(data.oldestPapers); setOldestStatus("done"); }
      if (data.recentPapers?.length) { setRecentPapers(data.recentPapers); setRecentStatus("done"); }
      if (data.recentSearchTerm)     setRecentSearchTerm(data.recentSearchTerm);
      if (data.conceptsAI)     { setConceptsAI(data.conceptsAI); setConceptsStatus("done"); conceptsTextRef.current = data.conceptsAI; }
      if (data.ideasAI)        { setIdeasAI(data.ideasAI); setIdeasStatus("done"); }
      if (data.originAI || data.conceptsAI || data.ideasAI || data.recentPapers?.length) {
        setShowRestoreBanner(true);
      }
    } catch { /* 静默 */ }
  }, []);

  function handleClear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* 静默 */ }
    setShowRestoreBanner(false);
    setConcept("");
    setCurrentConcept("");
    resetAll();
  }

  async function handleExplore() {
    const term = concept.trim();
    if (!term) return;
    setShowRestoreBanner(false);
    resetAll();
    setIsExploring(true);
    setCurrentConcept(term);

    // ── 区块 1 + 2：并行启动 ────────────────────────────────────────────────

    // 区块 1：最早论文（非流式）—— 先查真实数据，再喂给 AI 溯源，AI 不再自己瞎猜论文
    setOldestStatus("loading");
    const oldestPromise = fetchPapers(term, "oldest").then(papers => {
      setOldestPapers(papers);
      setOldestStatus("done");
      return papers;
    }).catch(() => {
      setOldestStatus("error");
      return [] as Paper[];
    });

    // 区块 2：近期论文（非流式，与区块 1 并行）
    setRecentStatus("loading");
    const recentPromise = fetchPapers(term, "recent").then(papers => {
      setRecentPapers(papers);
      setRecentStatus("done");
      // 论文卡片先展示，AI 一句话关联说明单独异步补上，不阻塞后续区块
      if (papers.length > 0) {
        fetchRelevanceSummaries(term, papers).then(setRecentPapers);
      }
      return papers;
    }).catch(() => {
      setRecentStatus("error");
      return [] as Paper[];
    });

    // 区块 1：AI 溯源（流式）—— 等最早论文查回来后，把真实论文传给 AI 做分析
    setOriginAIStatus("loading");
    const oldestPapersData = await oldestPromise;
    const block1Promise = streamBlock(term, 1, oldestPapersData, setOriginAI, setOriginAIStatus, originTextRef);

    // ── 区块 3：等区块 2 论文回来后开始 ─────────────────────────────────────
    const recentPapersData = await recentPromise;
    await streamBlock(term, 3, recentPapersData, setConceptsAI, setConceptsStatus, conceptsTextRef);

    // ── 区块 4：等区块 1 AI + 区块 3 都完成后开始 ────────────────────────────
    await block1Promise;
    await streamBlock(term, 4, recentPapersData, setIdeasAI, setIdeasStatus, { current: "" });

    setIsExploring(false);
  }

  const anyResult = originAIStatus !== "idle" || oldestStatus !== "idle" || recentStatus !== "idle";

  // 传给 ContextChat 的系统提示词，随探索结果动态更新
  const chatContext = useMemo(() => {
    if (!currentConcept) return "";
    const parts: string[] = [
      `你是一位专业的学术研究助手。用户正在探索以下概念：\n${currentConcept}`,
    ];
    if (originAI) parts.push(`\n概念溯源与AI分析：\n${originAI}`);
    if (conceptsAI) parts.push(`\n关联概念：\n${conceptsAI}`);
    if (ideasAI) parts.push(`\n研究思路建议：\n${ideasAI}`);
    parts.push("\n请基于以上概念探索结果，专业地回答用户的问题。");
    return parts.join("");
  }, [currentConcept, originAI, conceptsAI, ideasAI]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="概念探索" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-10 pb-24 sm:pb-12">
        <div className="w-full max-w-3xl space-y-5">

          {/* 标题 */}
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">🧭 概念探索器</h1>
            <p className="text-sm sm:text-base text-gray-500">
              输入一个专业名词，AI 帮你溯源、找最新文献、提取关联概念、给出研究思路
            </p>
          </div>

          {/* 恢复提示条 */}
          {showRestoreBanner && (
            <div className="flex items-center justify-between bg-blue-50 border border-blue-100 rounded-xl px-4 py-2.5">
              <span className="text-sm text-blue-700">✨ 已恢复上次的概念探索内容</span>
              <button
                onClick={handleClear}
                className="text-xs text-blue-400 hover:text-blue-600 transition-colors ml-4 shrink-0"
              >
                清空重新开始
              </button>
            </div>
          )}

          {/* 搜索框 */}
          <div className="bg-white rounded-2xl p-5 sm:p-6 shadow-sm border border-gray-100">
            <input
              type="text"
              value={concept}
              onChange={e => setConcept(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !isExploring) handleExplore(); }}
              placeholder="输入一个专业名词或概念，如：界面钝化、钙钛矿、注意力机制…"
              className="w-full rounded-xl border border-gray-200 px-4 py-3 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 mb-3"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">按 Enter 或点击按钮开始探索</span>
              <Button
                id="explore-btn"
                onClick={handleExplore}
                disabled={!concept.trim() || isExploring}
                size="lg"
                className="px-8"
              >
                {isExploring ? "探索中…" : "开始探索"}
              </Button>
            </div>
          </div>

          {/* ── 区块 1：概念溯源 ── */}
          <BlockWrapper
            title="概念溯源" icon="📖" borderColor="border-l-blue-500"
            status={originAIStatus !== "idle" ? originAIStatus : oldestStatus}
          >
            <div className="space-y-5">
              {/* AI 解释 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-blue-500 uppercase tracking-wide">AI 分析</p>
                  {originAIStatus === "done" && originAI && (
                    <button
                      onClick={() => handleSaveBlock("概念溯源", originAI)}
                      disabled={blockSaveStatus["概念溯源"] === "saving" || blockSaveStatus["概念溯源"] === "saved"}
                      className={`text-xs transition-colors flex items-center gap-1 ${
                        blockSaveStatus["概念溯源"] === "saved" ? "text-green-500 cursor-default" :
                        blockSaveStatus["概念溯源"] === "error" ? "text-red-400 hover:text-red-500" :
                        "text-gray-400 hover:text-blue-500"
                      }`}
                    >
                      {blockSaveStatus["概念溯源"] === "saving" ? "保存中…" :
                       blockSaveStatus["概念溯源"] === "saved"  ? "✓ 已保存" :
                       blockSaveStatus["概念溯源"] === "error"  ? "❌ 重试"  :
                       "💾 保存到笔记"}
                    </button>
                  )}
                </div>
                {originAIStatus === "loading" && !originAI && <Skeleton lines={5} />}
                {originAI && <MarkdownContent content={originAI} className="text-sm" />}
                {originAIStatus === "error" && <p className="text-sm text-red-500">AI 分析失败</p>}
              </div>

              {/* 数据库论文 */}
              <div>
                <p className="text-xs font-semibold text-blue-500 uppercase tracking-wide mb-2">
                  数据库验证结果（Semantic Scholar 最早相关论文）
                </p>
                {oldestStatus === "loading" && <Skeleton lines={2} />}
                {oldestStatus === "done" && oldestPapers.length === 0 && (
                  <p className="text-xs text-gray-400 italic">
                    未找到数据库结果，以下为 AI 知识库内容，请自行在知网验证
                  </p>
                )}
                {oldestPapers.length > 0 && (
                  <div className="space-y-2">
                    {oldestPapers.map((p, i) => <PaperCard key={p.paperId} paper={p} index={i} />)}
                  </div>
                )}
              </div>
            </div>
          </BlockWrapper>

          {/* ── 区块 2：最新进展 ── */}
          <BlockWrapper
            title={recentSearchTerm && recentSearchTerm !== currentConcept
              ? `最新进展（近 3 年高引论文 · 搜索词：${recentSearchTerm}）`
              : "最新进展（近 3 年高引论文）"}
            icon="🔥" borderColor="border-l-green-500"
            status={recentStatus}
          >
            {recentStatus === "loading" && <Skeleton lines={6} />}
            {recentStatus === "error" && (
              <p className="text-sm text-gray-400 italic">
                暂时无法连接论文数据库，请稍后重试
              </p>
            )}
            {recentStatus === "done" && recentPapers.length === 0 && (
              <p className="text-sm text-gray-400 italic">
                暂未找到相关论文，可以尝试输入英文名称搜索，或参考下方研究思路
              </p>
            )}
            {recentPapers.length > 0 && (
              <div className="space-y-3">
                {recentPapers.map((p, i) => <PaperCard key={p.paperId} paper={p} index={i} />)}
              </div>
            )}
          </BlockWrapper>

          {/* ── 区块 3：关联概念提取 ── */}
          <BlockWrapper
            title="关联概念提取" icon="🔗" borderColor="border-l-purple-500"
            status={conceptsStatus}
          >
            {conceptsStatus === "loading" && !conceptsAI && <Skeleton lines={8} />}
            {conceptsAI && (
              <>
                <MarkdownContent content={conceptsAI} className="text-sm" />
                <button
                  onClick={() => handleSaveBlock("关联概念", conceptsAI)}
                  disabled={blockSaveStatus["关联概念"] === "saving" || blockSaveStatus["关联概念"] === "saved"}
                  className={`mt-3 text-xs transition-colors flex items-center gap-1 ${
                    blockSaveStatus["关联概念"] === "saved" ? "text-green-500 cursor-default" :
                    blockSaveStatus["关联概念"] === "error" ? "text-red-400 hover:text-red-500" :
                    "text-gray-400 hover:text-blue-500"
                  }`}
                >
                  {blockSaveStatus["关联概念"] === "saving" ? "保存中…" :
                   blockSaveStatus["关联概念"] === "saved"  ? "✓ 已保存" :
                   blockSaveStatus["关联概念"] === "error"  ? "❌ 重试"  :
                   "💾 保存到笔记"}
                </button>
              </>
            )}
            {conceptsStatus === "error" && <p className="text-sm text-red-500">关联概念提取失败</p>}
          </BlockWrapper>

          {/* ── 区块 4：研究思路建议 ── */}
          <BlockWrapper
            title="研究思路建议" icon="💡" borderColor="border-l-orange-400"
            status={ideasStatus}
          >
            {ideasStatus === "loading" && !ideasAI && <Skeleton lines={6} />}
            {ideasAI && (
              <>
                <MarkdownContent content={ideasAI} className="text-sm" />
                <button
                  onClick={() => handleSaveBlock("研究思路", ideasAI)}
                  disabled={blockSaveStatus["研究思路"] === "saving" || blockSaveStatus["研究思路"] === "saved"}
                  className={`mt-3 text-xs transition-colors flex items-center gap-1 ${
                    blockSaveStatus["研究思路"] === "saved" ? "text-green-500 cursor-default" :
                    blockSaveStatus["研究思路"] === "error" ? "text-red-400 hover:text-red-500" :
                    "text-gray-400 hover:text-blue-500"
                  }`}
                >
                  {blockSaveStatus["研究思路"] === "saving" ? "保存中…" :
                   blockSaveStatus["研究思路"] === "saved"  ? "✓ 已保存" :
                   blockSaveStatus["研究思路"] === "error"  ? "❌ 重试"  :
                   "💾 保存到笔记"}
                </button>
              </>
            )}
            {ideasStatus === "error" && <p className="text-sm text-red-500">研究思路生成失败</p>}
          </BlockWrapper>

          {/* 底部操作区：保存 + 重新探索 */}
          {anyResult && !isExploring && (
            <div className="flex flex-col sm:flex-row gap-3">
              {/* 保存按钮——至少有一个区块生成内容才显示 */}
              {(originAI || recentPapers.length > 0 || conceptsAI || ideasAI) && (
                <Button
                  onClick={handleSaveNote}
                  disabled={saveStatus === "saving" || saveStatus === "saved"}
                  className="flex-1"
                >
                  {saveStatus === "saving" && "保存中…"}
                  {saveStatus === "saved"  && "✓ 已保存到我的研究笔记"}
                  {saveStatus === "error"  && "❌ 保存失败，点击重试"}
                  {saveStatus === "idle"   && "💾 保存到我的研究笔记"}
                </Button>
              )}
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleClear}
              >
                重新探索另一个概念
              </Button>
            </div>
          )}

          {/* 保存成功后显示跳转链接 */}
          {saveStatus === "saved" && savedNoteId && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-700 flex items-center justify-between">
              <span>✅ 探索结果已保存！</span>
              <a href="/my-notes" className="text-green-600 font-medium hover:underline">
                查看我的研究笔记 →
              </a>
            </div>
          )}

          {/* 深入探讨对话框 */}
          {anyResult && (
            <ContextChat
              context={chatContext}
              sectionTitle="深入探讨这个概念"
              placeholder={"你对这个概念还有什么疑问？\n比如：这个方法在我的研究中能怎么用？它和XX方法有什么区别？"}
              sourceType="concept"
              sourceTitle={currentConcept}
            />
          )}

        </div>
      </main>
    </div>
  );
}
