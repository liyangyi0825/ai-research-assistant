"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { MarkdownContent } from "@/components/MarkdownContent";

// ─── 类型定义 ────────────────────────────────────────────────────────────────

interface Paper {
  paperId: string;
  title: string;
  authors: string;
  year: number | null;
  abstract: string | null;
  citationCount: number;
  doi: string | null;
}

type Status = "idle" | "loading" | "done" | "error";

interface Note {
  concept: string;
  blockTitle: string;
  content: string;
  savedAt: string;
}

const NOTES_KEY = "concept-explorer-notes";

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
  title, icon, borderColor, status, children, onSave,
}: {
  title: string;
  icon: string;
  borderColor: string;
  status: Status;
  children: React.ReactNode;
  onSave?: () => void;
}) {
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setSaved(true);
    onSave?.();
    setTimeout(() => setSaved(false), 2000);
  }

  if (status === "idle") return null;

  return (
    <div className={`bg-white rounded-2xl shadow-sm border-l-4 ${borderColor} border border-gray-100 overflow-hidden`}>
      <div className="px-4 sm:px-6 py-3 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          <span>{icon}</span>
          <span>{title}</span>
          {status === "loading" && (
            <span className="text-xs font-normal text-gray-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" />
            </span>
          )}
        </h2>
        {status === "done" && onSave && (
          <button
            onClick={handleSave}
            className="text-xs text-gray-400 hover:text-blue-500 transition-colors flex items-center gap-1"
          >
            {saved ? "✓ 已保存" : "🔖 保存到笔记"}
          </button>
        )}
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
          <p className="text-sm font-medium text-gray-800 leading-snug">{paper.title}</p>
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

  // ── 笔记状态 ──
  const [notes, setNotes] = useState<Note[]>([]);
  const [showNotes, setShowNotes] = useState(false);

  // 从 localStorage 初始化笔记（仅客户端）
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(NOTES_KEY) ?? "[]");
      setNotes(saved);
    } catch { /* ignore */ }
  }, []);

  function saveNote(conceptName: string, blockTitle: string, content: string) {
    if (!content.trim()) return;
    const newNote: Note = { concept: conceptName, blockTitle, content, savedAt: new Date().toISOString() };
    setNotes(prev => {
      const updated = [newNote, ...prev].slice(0, 100);
      try { localStorage.setItem(NOTES_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
      return updated;
    });
    setShowNotes(true); // 保存后自动展开笔记面板
  }

  function deleteNote(index: number) {
    setNotes(prev => {
      const updated = prev.filter((_, i) => i !== index);
      try { localStorage.setItem(NOTES_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
      return updated;
    });
  }

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

  async function handleExplore() {
    if (!concept.trim()) return;
    resetAll();
    setIsExploring(true);
    const term = concept.trim();
    setCurrentConcept(term);

    // ── 区块 1 + 2：并行启动 ────────────────────────────────────────────────

    // 区块 1：AI 溯源（流式）—— 直接传 term，不用 currentConcept state
    setOriginAIStatus("loading");
    const block1Promise = streamBlock(term, 1, [], setOriginAI, setOriginAIStatus, originTextRef);

    // 区块 1：最早论文（非流式）
    setOldestStatus("loading");
    const oldestPromise = fetchPapers(term, "oldest").then(papers => {
      setOldestPapers(papers);
      setOldestStatus("done");
      return papers;
    }).catch(() => {
      setOldestStatus("error");
      return [] as Paper[];
    });

    // 区块 2：近期论文（非流式）
    setRecentStatus("loading");
    const recentPromise = fetchPapers(term, "recent").then(papers => {
      setRecentPapers(papers);
      setRecentStatus("done");
      return papers;
    }).catch(() => {
      setRecentStatus("error");
      return [] as Paper[];
    });

    // ── 区块 3：等区块 2 论文回来后开始 ─────────────────────────────────────
    const recentPapersData = await recentPromise;
    await streamBlock(term, 3, recentPapersData, setConceptsAI, setConceptsStatus, conceptsTextRef);

    // ── 区块 4：等区块 1 AI + 区块 3 都完成后开始 ────────────────────────────
    await block1Promise;
    await oldestPromise;
    await streamBlock(term, 4, recentPapersData, setIdeasAI, setIdeasStatus, { current: "" });

    setIsExploring(false);
  }

  const anyResult = originAIStatus !== "idle" || oldestStatus !== "idle" || recentStatus !== "idle";

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
            onSave={() => saveNote(currentConcept, "概念溯源", originAI)}
          >
            <div className="space-y-5">
              {/* AI 解释 */}
              <div>
                <p className="text-xs font-semibold text-blue-500 uppercase tracking-wide mb-2">AI 分析</p>
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
            onSave={() => saveNote(
              currentConcept, "最新进展",
              recentPapers.map(p => `${p.title} (${p.year})`).join("\n")
            )}
          >
            {recentStatus === "loading" && <Skeleton lines={6} />}
            {recentStatus === "done" && recentPapers.length === 0 && (
              <p className="text-sm text-gray-400 italic">
                未找到近 3 年的数据库结果，以下为 AI 知识库内容，请自行在知网验证
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
            onSave={() => saveNote(currentConcept, "关联概念", conceptsAI)}
          >
            {conceptsStatus === "loading" && !conceptsAI && <Skeleton lines={8} />}
            {conceptsAI && <MarkdownContent content={conceptsAI} className="text-sm" />}
            {conceptsStatus === "error" && <p className="text-sm text-red-500">关联概念提取失败</p>}
          </BlockWrapper>

          {/* ── 区块 4：研究思路建议 ── */}
          <BlockWrapper
            title="研究思路建议" icon="💡" borderColor="border-l-orange-400"
            status={ideasStatus}
            onSave={() => saveNote(currentConcept, "研究思路", ideasAI)}
          >
            {ideasStatus === "loading" && !ideasAI && <Skeleton lines={6} />}
            {ideasAI && <MarkdownContent content={ideasAI} className="text-sm" />}
            {ideasStatus === "error" && <p className="text-sm text-red-500">研究思路生成失败</p>}
          </BlockWrapper>

          {/* 重新探索 */}
          {anyResult && !isExploring && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => { resetAll(); setConcept(""); setCurrentConcept(""); }}
            >
              重新探索另一个概念
            </Button>
          )}

          {/* ── 我的笔记 ── */}
          {notes.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <button
                className="w-full px-4 sm:px-6 py-3.5 flex items-center justify-between hover:bg-gray-50 transition-colors"
                onClick={() => setShowNotes(v => !v)}
              >
                <span className="font-semibold text-gray-700 flex items-center gap-2">
                  📓 我的笔记
                  <span className="text-xs font-normal text-blue-500 bg-blue-50 px-2 py-0.5 rounded-full">
                    {notes.length} 条
                  </span>
                </span>
                <span className="text-gray-400 text-sm">{showNotes ? "▲ 收起" : "▼ 展开"}</span>
              </button>

              {showNotes && (
                <div className="border-t border-gray-100 p-4 sm:p-5 space-y-3">
                  {notes.map((note, i) => (
                    <div key={i} className="border border-gray-100 rounded-xl p-3 hover:border-gray-200 transition-colors">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full font-medium">
                            {note.concept}
                          </span>
                          <span className="text-xs text-gray-500">{note.blockTitle}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-xs text-gray-400">
                            {new Date(note.savedAt).toLocaleDateString("zh-CN")}
                          </span>
                          <button
                            onClick={() => deleteNote(i)}
                            className="text-xs text-gray-300 hover:text-red-400 transition-colors"
                          >
                            删除
                          </button>
                        </div>
                      </div>
                      <p className="text-xs text-gray-600 leading-relaxed line-clamp-3 whitespace-pre-line">
                        {note.content.replace(/[#*`>]/g, "").slice(0, 200)}
                        {note.content.length > 200 && "…"}
                      </p>
                    </div>
                  ))}
                  <button
                    onClick={() => {
                      if (window.confirm("确定清空所有笔记？此操作不可撤销。")) {
                        setNotes([]);
                        localStorage.removeItem(NOTES_KEY);
                      }
                    }}
                    className="text-xs text-gray-400 hover:text-red-400 transition-colors"
                  >
                    清空所有笔记
                  </button>
                </div>
              )}
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
