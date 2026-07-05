"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { MarkdownContent } from "@/components/MarkdownContent";

// ── Types ───────────────────────────────────────────────────────────────────

interface Paper {
  title: string;
  authors: string;
  year: number | null;
  citationCount: number;
  doi: string | null;
}

interface ResearchNote {
  id: string;
  concept: string;
  origin_summary: string | null;
  latest_papers: Paper[] | null;
  related_concepts: string | null;
  research_ideas: string | null;
  user_memo: string | null;
  created_at: string;
  source_type: string | null;
  source_id: string | null;
  source_title: string | null;
}

interface HistoryItem {
  id: string;
  type: "keyword_gen" | "concept_explore";
  query: string;
  created_at: string;
}

type Tab = "notes" | "history";

// ── 来源标签 ─────────────────────────────────────────────────────────────────

function SourceTag({ note }: { note: ResearchNote }) {
  if (!note.source_type) return null;
  let label = "";
  let cls   = "";
  switch (note.source_type) {
    case "summary":
      label = `📄 来自论文：${note.source_title || ""}`;
      cls   = "bg-blue-50 text-blue-600 border-blue-100";
      break;
    case "chat":
      label = `💬 来自对话：${note.source_title || ""}`;
      cls   = "bg-violet-50 text-violet-600 border-violet-100";
      break;
    case "keyword":
      label = `🔍 来自检索词探讨`;
      cls   = "bg-amber-50 text-amber-600 border-amber-100";
      break;
    case "concept":
      label = `🧭 来自概念探索：${note.source_title || note.concept}`;
      cls   = "bg-green-50 text-green-700 border-green-100";
      break;
    default:
      return null;
  }
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full border font-medium ${cls}`}>
      {label}
    </span>
  );
}

// ── 研究笔记卡片 ─────────────────────────────────────────────────────────────

function NoteCard({ note, onDelete }: { note: ResearchNote; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [memo, setMemo] = useState(note.user_memo ?? "");
  const [memoSaving, setMemoSaving] = useState(false);
  const [memoSaved, setMemoSaved]   = useState(false);
  const [deleting, setDeleting]     = useState(false);

  async function saveMemo() {
    setMemoSaving(true);
    try {
      await fetch(`/api/notes/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_memo: memo }),
      });
      setMemoSaved(true);
      setTimeout(() => setMemoSaved(false), 2000);
    } finally {
      setMemoSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`确定删除这条笔记？`)) return;
    setDeleting(true);
    await fetch(`/api/notes/${note.id}`, { method: "DELETE" });
    onDelete();
  }

  // 是否为快速保存（论文总结/对话/检索词）
  const isQuickNote = note.source_type && note.source_type !== "concept";

  // 概念探索多区块
  const sections = [
    { label: "📖 概念溯源", content: note.origin_summary,  color: "blue" },
    { label: "🔗 关联概念", content: note.related_concepts, color: "purple" },
    { label: "💡 研究思路", content: note.research_ideas,   color: "orange" },
  ].filter(s => s.content);

  const formattedDate = new Date(note.created_at).toLocaleDateString("zh-CN", {
    year: "numeric", month: "long", day: "numeric",
  });

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* ─ 卡片头：点击展开 ─ */}
      <button
        className="w-full px-4 sm:px-6 py-4 flex items-start justify-between hover:bg-gray-50 transition-colors text-left gap-3"
        onClick={() => setOpen(v => !v)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="font-bold text-gray-800 text-base leading-snug">{note.concept}</span>
            <SourceTag note={note} />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <span>{formattedDate}</span>
            {note.user_memo && (
              <span className="bg-yellow-50 text-yellow-700 px-2 py-0.5 rounded-full border border-yellow-100">有我的想法</span>
            )}
          </div>
        </div>
        <span className="text-gray-400 text-sm shrink-0">{open ? "▲ 收起" : "▼ 展开"}</span>
      </button>

      {/* ─ 展开内容 ─ */}
      {open && (
        <div className="border-t border-gray-100 p-4 sm:p-6 space-y-5">

          {/* 快速笔记：直接显示保存的内容 */}
          {isQuickNote && note.origin_summary && (
            <div className={`border-l-4 pl-3 ${
              note.source_type === "summary" ? "border-l-blue-400" :
              note.source_type === "chat"    ? "border-l-violet-400" :
                                               "border-l-amber-400"
            }`}>
              <MarkdownContent content={note.origin_summary} className="text-sm" />
            </div>
          )}

          {/* 概念探索笔记：显示各区块 */}
          {!isQuickNote && (
            <>
              {sections.map(s => (
                <div key={s.label} className={`border-l-4 ${
                  s.color === "blue"   ? "border-l-blue-400"   :
                  s.color === "purple" ? "border-l-purple-400" : "border-l-orange-400"
                } pl-3`}>
                  <p className="text-xs font-semibold text-gray-500 mb-1.5">{s.label}</p>
                  <MarkdownContent content={s.content!} className="text-sm" />
                </div>
              ))}

              {note.latest_papers && note.latest_papers.length > 0 && (
                <div className="border-l-4 border-l-green-400 pl-3">
                  <p className="text-xs font-semibold text-gray-500 mb-2">🔥 最新进展论文</p>
                  <div className="space-y-1.5">
                    {note.latest_papers.slice(0, 5).map((p, i) => (
                      <div key={i} className="text-sm text-gray-700">
                        <span className="text-gray-400 mr-1.5">#{i + 1}</span>
                        <span className="font-medium">{p.title}</span>
                        <span className="text-gray-400 ml-2 text-xs">{p.authors} · {p.year}</span>
                      </div>
                    ))}
                    {note.latest_papers.length > 5 && (
                      <p className="text-xs text-gray-400">…共 {note.latest_papers.length} 篇</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* 我的备注 */}
          <div className="border-l-4 border-l-yellow-400 pl-3">
            <p className="text-xs font-semibold text-gray-500 mb-2">✏️ 我的备注</p>
            <textarea
              value={memo}
              onChange={e => setMemo(e.target.value)}
              placeholder="记录你对这段内容的思考、想法、问题……"
              rows={3}
              className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none leading-relaxed"
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-gray-400">Ctrl+Enter 保存</span>
              <Button
                size="sm"
                onClick={saveMemo}
                disabled={memoSaving || memo === (note.user_memo ?? "")}
                className="h-8 text-xs"
                onKeyDown={e => { if (e.key === "Enter" && e.ctrlKey) saveMemo(); }}
              >
                {memoSaving ? "保存中…" : memoSaved ? "✓ 已保存" : "保存备注"}
              </Button>
            </div>
          </div>

          {/* 删除 */}
          <div className="flex justify-end pt-1">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="text-xs text-gray-300 hover:text-red-400 transition-colors"
            >
              {deleting ? "删除中…" : "🗑 删除这条笔记"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 搜索历史工具函数 ──────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff  = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  1) return "刚刚";
  if (mins  < 60) return `${mins} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days  <  7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function historyTypeLabel(type: HistoryItem["type"]) {
  return type === "keyword_gen"
    ? { icon: "🔍", text: "关键词矩阵", color: "bg-blue-50 text-blue-600 border-blue-100" }
    : { icon: "🧭", text: "概念探索",   color: "bg-violet-50 text-violet-600 border-violet-100" };
}

function historySearchUrl(item: HistoryItem) {
  const q = encodeURIComponent(item.query);
  return item.type === "keyword_gen"
    ? `/literature-search?q=${q}`
    : `/concept-explorer?q=${q}`;
}

// ── 主页面 ───────────────────────────────────────────────────────────────────

export default function MyNotesPage() {
  const [tab, setTab] = useState<Tab>("notes");

  // 研究笔记数据
  const [notes,        setNotes]        = useState<ResearchNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [notesError,   setNotesError]   = useState("");

  // 搜索历史数据
  const [history,        setHistory]        = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [deleting,       setDeleting]       = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing,         setClearing]         = useState(false);

  // 并行加载两份数据
  useEffect(() => {
    fetch("/api/notes")
      .then(r => r.json())
      .then(d => { setNotes(d.notes ?? []); setNotesLoading(false); })
      .catch(() => { setNotesError("加载失败，请刷新页面"); setNotesLoading(false); });

    fetch("/api/search-history")
      .then(r => r.json())
      .then(d => { setHistory(d.history ?? []); setHistoryLoading(false); })
      .catch(() => setHistoryLoading(false));
  }, []);

  async function handleDeleteHistory(id: string) {
    setDeleting(id);
    try {
      await fetch("/api/search-history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setHistory(prev => prev.filter(h => h.id !== id));
    } finally {
      setDeleting(null);
    }
  }

  async function handleClearHistory() {
    setClearing(true);
    try {
      await fetch("/api/search-history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      setHistory([]);
    } finally {
      setClearing(false);
      setShowClearConfirm(false);
    }
  }

  const kwCount = history.filter(h => h.type === "keyword_gen").length;
  const ceCount = history.filter(h => h.type === "concept_explore").length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="笔记与历史" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-10 pb-24 sm:pb-12">
        <div className="w-full max-w-3xl space-y-4">

          {/* 标题 */}
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800">📓 笔记与历史</h1>

          {/* Tab 切换 */}
          <div className="flex gap-2">
            <button
              onClick={() => setTab("notes")}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${
                tab === "notes"
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
              }`}
            >
              📓 研究笔记
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                tab === "notes" ? "bg-white/20 text-white" : "bg-gray-100 text-gray-500"
              }`}>{notesLoading ? "…" : notes.length}</span>
            </button>

            <button
              onClick={() => setTab("history")}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${
                tab === "history"
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
              }`}
            >
              🕐 搜索历史
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                tab === "history" ? "bg-white/20 text-white" : "bg-gray-100 text-gray-500"
              }`}>{historyLoading ? "…" : history.length}</span>
            </button>
          </div>

          {/* ── 研究笔记 Tab ── */}
          {tab === "notes" && (
            <>
              <p className="text-sm text-gray-500 -mt-1">
                来自论文总结、AI对话、检索词探讨和概念探索的保存记录
              </p>

              {notesLoading && (
                <div className="space-y-4 animate-pulse">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
                      <div className="h-5 bg-gray-200 rounded w-1/3 mb-3" />
                      <div className="h-3 bg-gray-100 rounded w-full mb-2" />
                      <div className="h-3 bg-gray-100 rounded w-4/5" />
                    </div>
                  ))}
                </div>
              )}

              {notesError && (
                <div className="bg-white rounded-2xl p-6 text-center text-red-500 text-sm">{notesError}</div>
              )}

              {!notesLoading && !notesError && notes.length === 0 && (
                <div className="bg-white rounded-2xl p-10 text-center shadow-sm border border-gray-100">
                  <div className="text-4xl mb-3">📭</div>
                  <p className="text-gray-500 text-sm mb-4">还没有保存过任何笔记</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Link href="/upload" className="text-sm text-blue-500 hover:underline">
                      去分析论文 →
                    </Link>
                    <span className="text-gray-300">·</span>
                    <Link href="/concept-explorer" className="text-sm text-blue-500 hover:underline">
                      去概念探索器 →
                    </Link>
                  </div>
                </div>
              )}

              {notes.map(note => (
                <NoteCard
                  key={note.id}
                  note={note}
                  onDelete={() => setNotes(prev => prev.filter(n => n.id !== note.id))}
                />
              ))}
            </>
          )}

          {/* ── 搜索历史 Tab ── */}
          {tab === "history" && (
            <>
              <p className="text-sm text-gray-500 -mt-1">
                关键词矩阵和概念探索器的历史记录，点击可重新搜索
              </p>

              {/* 类型统计 + 清空按钮 */}
              {history.length > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex gap-2 text-xs text-gray-400">
                    <span>🔍 关键词矩阵 {kwCount} 条</span>
                    <span>·</span>
                    <span>🧭 概念探索 {ceCount} 条</span>
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 text-xs px-3"
                    onClick={() => setShowClearConfirm(true)}
                  >
                    清空搜索历史
                  </Button>
                </div>
              )}

              {historyLoading && (
                <div className="bg-white rounded-2xl p-8 text-center text-gray-400 shadow-sm">
                  <div className="animate-pulse space-y-3">
                    {[1, 2, 3].map(i => <div key={i} className="h-12 bg-gray-100 rounded-xl" />)}
                  </div>
                </div>
              )}

              {!historyLoading && history.length === 0 && (
                <div className="bg-white rounded-2xl p-10 text-center shadow-sm border border-gray-100">
                  <p className="text-3xl mb-3">📭</p>
                  <p className="text-gray-500 text-sm">还没有搜索记录</p>
                  <div className="flex gap-2 justify-center mt-4">
                    <Link href="/literature-search">
                      <Button size="sm" variant="outline">去生成检索词</Button>
                    </Link>
                    <Link href="/concept-explorer">
                      <Button size="sm" variant="outline">去探索概念</Button>
                    </Link>
                  </div>
                </div>
              )}

              {!historyLoading && history.length > 0 && (
                <div className="space-y-2">
                  {history.map((item) => {
                    const { icon, text, color } = historyTypeLabel(item.type);
                    return (
                      <div
                        key={item.id}
                        className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3 hover:border-blue-200 hover:shadow-sm transition-all"
                      >
                        <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full border font-medium ${color}`}>
                          {icon} {text}
                        </span>

                        <span className="flex-1 text-sm text-gray-800 font-medium truncate">
                          {item.query}
                        </span>

                        <span className="shrink-0 text-xs text-gray-400 hidden sm:block">
                          {relativeTime(item.created_at)}
                        </span>

                        <Link href={historySearchUrl(item)} className="shrink-0">
                          <Button size="sm" className="text-xs h-7 px-3">
                            重新搜索
                          </Button>
                        </Link>

                        <button
                          onClick={() => handleDeleteHistory(item.id)}
                          disabled={deleting === item.id}
                          className="shrink-0 text-gray-300 hover:text-red-400 transition-colors p-1 rounded"
                          title="删除"
                        >
                          {deleting === item.id ? "…" : "✕"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

        </div>
      </main>

      {/* 清空搜索历史 - 确认弹窗 */}
      {showClearConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget && !clearing) setShowClearConfirm(false); }}
        >
          <div className="bg-white w-full max-w-sm rounded-2xl shadow-2xl p-6">
            <h2 className="font-semibold text-gray-800 mb-2">清空搜索历史</h2>
            <p className="text-sm text-gray-500 mb-6">确定要清空所有搜索历史吗？此操作不可撤销。</p>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowClearConfirm(false)}
                disabled={clearing}
              >
                取消
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleClearHistory}
                disabled={clearing}
              >
                {clearing ? "清空中…" : "确认清空"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
