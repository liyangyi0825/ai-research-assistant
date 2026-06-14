"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";

interface HistoryItem {
  id: string;
  type: "keyword_gen" | "concept_explore";
  query: string;
  created_at: string;
}

type Filter = "all" | "keyword_gen" | "concept_explore";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  1) return "刚刚";
  if (mins  < 60) return `${mins} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days  <  7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function typeLabel(type: HistoryItem["type"]) {
  return type === "keyword_gen"
    ? { icon: "🔍", text: "关键词矩阵", color: "bg-blue-50 text-blue-600 border-blue-100" }
    : { icon: "🧭", text: "概念探索",   color: "bg-violet-50 text-violet-600 border-violet-100" };
}

function searchUrl(item: HistoryItem) {
  const q = encodeURIComponent(item.query);
  return item.type === "keyword_gen"
    ? `/literature-search?q=${q}`
    : `/concept-explorer?q=${q}`;
}

export default function SearchHistoryPage() {
  const [history, setHistory]   = useState<HistoryItem[]>([]);
  const [loading, setLoading]   = useState(true);
  const [filter,  setFilter]    = useState<Filter>("all");
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/search-history")
      .then(r => r.json())
      .then(d => { setHistory(d.history ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function handleDelete(id: string) {
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

  const filtered = filter === "all" ? history : history.filter(h => h.type === filter);
  const kwCount  = history.filter(h => h.type === "keyword_gen").length;
  const ceCount  = history.filter(h => h.type === "concept_explore").length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="搜索历史" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-12 pb-24 sm:pb-12">
        <div className="w-full max-w-2xl space-y-4">

          {/* 标题 */}
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">📋 搜索历史</h1>
            <p className="text-sm text-gray-500">关键词矩阵和概念探索器的历史记录，点击可重新搜索</p>
          </div>

          {/* 筛选 Tab */}
          <div className="flex gap-2">
            {([
              ["all",             "全部",       history.length],
              ["keyword_gen",     "🔍 关键词矩阵", kwCount],
              ["concept_explore", "🧭 概念探索",   ceCount],
            ] as [Filter, string, number][]).map(([f, label, count]) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium border transition-colors ${
                  filter === f
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                }`}
              >
                {label}
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                  filter === f ? "bg-white/20 text-white" : "bg-gray-100 text-gray-500"
                }`}>{count}</span>
              </button>
            ))}
          </div>

          {/* 内容区 */}
          {loading ? (
            <div className="bg-white rounded-2xl p-8 text-center text-gray-400 shadow-sm">
              <div className="animate-pulse space-y-3">
                {[1,2,3].map(i => <div key={i} className="h-12 bg-gray-100 rounded-xl" />)}
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
              <p className="text-3xl mb-3">📭</p>
              <p className="text-gray-500 text-sm">
                {filter === "all" ? "还没有搜索记录" : "没有该类型的历史记录"}
              </p>
              <div className="flex gap-2 justify-center mt-4">
                <Link href="/literature-search">
                  <Button size="sm" variant="outline">去生成检索词</Button>
                </Link>
                <Link href="/concept-explorer">
                  <Button size="sm" variant="outline">去探索概念</Button>
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((item) => {
                const { icon, text, color } = typeLabel(item.type);
                return (
                  <div
                    key={item.id}
                    className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3 hover:border-blue-200 hover:shadow-sm transition-all"
                  >
                    {/* 类型标签 */}
                    <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full border font-medium ${color}`}>
                      {icon} {text}
                    </span>

                    {/* 查询内容 */}
                    <span className="flex-1 text-sm text-gray-800 font-medium truncate">
                      {item.query}
                    </span>

                    {/* 时间 */}
                    <span className="shrink-0 text-xs text-gray-400 hidden sm:block">
                      {relativeTime(item.created_at)}
                    </span>

                    {/* 重新搜索 */}
                    <Link href={searchUrl(item)} className="shrink-0">
                      <Button size="sm" className="text-xs h-7 px-3">
                        重新搜索
                      </Button>
                    </Link>

                    {/* 删除 */}
                    <button
                      onClick={() => handleDelete(item.id)}
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

        </div>
      </main>
    </div>
  );
}
