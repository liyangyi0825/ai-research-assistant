"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";

interface Paper {
  id: string;
  title: string;
  file_name: string | null;
  char_count: number;
  features_used: string[];
  created_at: string;
}

const FEATURE_CFG: Record<string, { icon: string; label: string; cls: string }> = {
  summary:   { icon: "📋", label: "总结",  cls: "bg-blue-50 text-blue-600 border-blue-100" },
  translate: { icon: "🌐", label: "翻译",  cls: "bg-amber-50 text-amber-600 border-amber-100" },
  ppt:       { icon: "🎯", label: "PPT",   cls: "bg-purple-50 text-purple-600 border-purple-100" },
};

const PAGE_SIZE = 20;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

export default function MyPapersPage() {
  const router = useRouter();
  const [papers, setPapers]     = useState<Paper[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [search, setSearch]     = useState("");
  const [query, setQuery]       = useState(""); // debounced
  const [loading, setLoading]   = useState(true);

  // 300 ms debounce
  useEffect(() => {
    const t = setTimeout(() => { setQuery(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPapers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: PAGE_SIZE.toString(),
        ...(query ? { search: query } : {}),
      });
      const res = await fetch(`/api/my-papers?${params}`);
      const data = await res.json();
      setPapers(data.papers ?? []);
      setTotal(data.total ?? 0);
    } catch { /* 静默 */ }
    finally { setLoading(false); }
  }, [page, query]);

  useEffect(() => { fetchPapers(); }, [fetchPapers]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="min-h-full" style={{ background: "#F8FAFC" }}>
      <Header title="我的论文" />

      <main className="max-w-3xl mx-auto px-4 py-8 pb-16">
        {/* 页头 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-800 mb-0.5">📚 我的论文</h1>
            <p className="text-sm text-gray-500">所有上传过的论文，点击继续分析</p>
          </div>
          <Link
            href="/upload"
            className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-all"
            style={{ background: "#3B82F6" }}
          >
            + 上传新论文
          </Link>
        </div>

        {/* 搜索栏 */}
        <div className="relative mb-5">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="按标题搜索…"
            className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 bg-white text-sm outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 transition-all"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none"
            >
              ×
            </button>
          )}
        </div>

        {/* 加载中 */}
        {loading && (
          <div className="text-center py-16 text-gray-400">
            <div className="text-3xl mb-3 animate-spin">⏳</div>
            <p>加载中…</p>
          </div>
        )}

        {/* 空状态 */}
        {!loading && papers.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <div className="text-5xl mb-4">📭</div>
            <p className="text-base">
              {query ? `没有找到「${query}」相关的论文` : "还没有上传过论文"}
            </p>
            {!query && (
              <Link href="/upload" className="mt-3 inline-block text-sm text-blue-500 hover:underline">
                上传第一篇论文 →
              </Link>
            )}
            {query && (
              <button onClick={() => setSearch("")} className="mt-3 text-sm text-blue-500 hover:underline">
                清空搜索
              </button>
            )}
          </div>
        )}

        {/* 论文列表 */}
        {!loading && papers.length > 0 && (
          <>
            <div className="text-xs text-gray-400 mb-3">
              共 {total} 篇{query && `（搜索"${query}"）`}
            </div>

            <div className="space-y-2.5">
              {papers.map((paper) => (
                <div
                  key={paper.id}
                  onClick={() => router.push(`/upload?paper=${paper.id}`)}
                  className="bg-white rounded-xl border border-gray-100 px-4 py-3.5 hover:border-blue-200 hover:shadow-sm transition-all cursor-pointer group"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {/* 标题 */}
                      <p className="font-semibold text-gray-800 text-sm leading-snug group-hover:text-blue-600 transition-colors">
                        {paper.title}
                      </p>
                      {/* 文件名（如与标题不同则显示） */}
                      {paper.file_name && paper.file_name !== paper.title && (
                        <p className="text-xs text-gray-400 mt-0.5 truncate">{paper.file_name}</p>
                      )}
                      {/* 时间 + 字符数 */}
                      <p className="text-xs text-gray-400 mt-1">
                        {formatDate(paper.created_at)}
                        {paper.char_count > 0 && (
                          <span className="ml-2 text-gray-300">·</span>
                        )}
                        {paper.char_count > 0 && (
                          <span className="ml-2">{paper.char_count.toLocaleString()} 字符</span>
                        )}
                      </p>
                    </div>

                    {/* 功能标签 */}
                    <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
                      {paper.features_used.length === 0 ? (
                        <span className="text-xs text-gray-300 px-2 py-0.5 rounded-full border border-gray-100">
                          未分析
                        </span>
                      ) : (
                        paper.features_used.map((f) => {
                          const cfg = FEATURE_CFG[f];
                          if (!cfg) return null;
                          return (
                            <span
                              key={f}
                              className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cfg.cls}`}
                            >
                              {cfg.icon} {cfg.label}
                            </span>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-8">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 disabled:opacity-40 hover:border-gray-400 transition-colors"
                >
                  ← 上一页
                </button>
                <span className="text-sm text-gray-500">
                  {page} / {totalPages} 页
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 disabled:opacity-40 hover:border-gray-400 transition-colors"
                >
                  下一页 →
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
