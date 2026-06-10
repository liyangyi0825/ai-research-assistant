"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { MarkdownContent } from "@/components/MarkdownContent";

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
}

function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="h-5 bg-gray-200 rounded w-1/3 mb-3" />
          <div className="h-3 bg-gray-100 rounded w-full mb-2" />
          <div className="h-3 bg-gray-100 rounded w-4/5" />
        </div>
      ))}
    </div>
  );
}

function NoteCard({ note, onDelete }: { note: ResearchNote; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [memo, setMemo] = useState(note.user_memo ?? "");
  const [memoSaving, setMemoSaving] = useState(false);
  const [memoSaved, setMemoSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    if (!window.confirm(`确定删除「${note.concept}」的笔记？`)) return;
    setDeleting(true);
    await fetch(`/api/notes/${note.id}`, { method: "DELETE" });
    onDelete();
  }

  const sections = [
    { label: "📖 概念溯源", content: note.origin_summary, color: "blue" },
    { label: "🔗 关联概念", content: note.related_concepts, color: "purple" },
    { label: "💡 研究思路", content: note.research_ideas, color: "orange" },
  ].filter(s => s.content);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* 卡片头部 */}
      <button
        className="w-full px-4 sm:px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors text-left"
        onClick={() => setOpen(v => !v)}
      >
        <div>
          <span className="font-bold text-gray-800 text-base">{note.concept}</span>
          <span className="ml-3 text-xs text-gray-400">
            {new Date(note.created_at).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}
          </span>
          {note.user_memo && (
            <span className="ml-2 text-xs bg-yellow-50 text-yellow-700 px-2 py-0.5 rounded-full">有我的想法</span>
          )}
        </div>
        <span className="text-gray-400 text-sm shrink-0 ml-2">{open ? "▲ 收起" : "▼ 展开"}</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 p-4 sm:p-6 space-y-5">

          {/* AI 内容区块 */}
          {sections.map(s => (
            <div key={s.label} className={`border-l-4 ${
              s.color === "blue"   ? "border-l-blue-400"   :
              s.color === "purple" ? "border-l-purple-400" : "border-l-orange-400"
            } pl-3`}>
              <p className="text-xs font-semibold text-gray-500 mb-1.5">{s.label}</p>
              <MarkdownContent content={s.content!} className="text-sm" />
            </div>
          ))}

          {/* 最新进展论文列表 */}
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

          {/* 我的想法输入区 */}
          <div className="border-l-4 border-l-yellow-400 pl-3">
            <p className="text-xs font-semibold text-gray-500 mb-2">✏️ 我的想法</p>
            <textarea
              value={memo}
              onChange={e => setMemo(e.target.value)}
              placeholder="记录你对这个概念的思考、导师建议、实验方向……"
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
                {memoSaving ? "保存中…" : memoSaved ? "✓ 已保存" : "保存想法"}
              </Button>
            </div>
          </div>

          {/* 删除按钮 */}
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

export default function MyNotesPage() {
  const [notes, setNotes] = useState<ResearchNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/notes")
      .then(r => r.json())
      .then(d => {
        setNotes(d.notes ?? []);
        setLoading(false);
      })
      .catch(() => {
        setError("加载失败，请刷新页面");
        setLoading(false);
      });
  }, []);

  function removeNote(id: string) {
    setNotes(prev => prev.filter(n => n.id !== id));
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="我的研究笔记" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-10 pb-24 sm:pb-12">
        <div className="w-full max-w-3xl space-y-4">

          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-800">📓 我的研究笔记</h1>
              <p className="text-sm text-gray-500 mt-0.5">概念探索的保存记录，在与论文对话时会作为背景上下文参考</p>
            </div>
            {notes.length > 0 && (
              <span className="text-sm text-gray-400 shrink-0">{notes.length} 条</span>
            )}
          </div>

          {loading && <Skeleton />}

          {error && (
            <div className="bg-white rounded-2xl p-6 text-center text-red-500 text-sm">{error}</div>
          )}

          {!loading && !error && notes.length === 0 && (
            <div className="bg-white rounded-2xl p-10 text-center shadow-sm border border-gray-100">
              <div className="text-4xl mb-3">📭</div>
              <p className="text-gray-500 text-sm">还没有保存过任何概念探索记录</p>
              <a href="/concept-explorer" className="mt-4 inline-block text-blue-500 text-sm hover:underline">
                去概念探索器 →
              </a>
            </div>
          )}

          {notes.map(note => (
            <NoteCard key={note.id} note={note} onDelete={() => removeNote(note.id)} />
          ))}

        </div>
      </main>
    </div>
  );
}
