"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";

interface Paper {
  id: string;
  title: string;
  file_size: number | null;
  created_at: string;
}

const PAGE_SIZE = 20;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MyPapersPage() {
  const router = useRouter();
  const [papers, setPapers]   = useState<Paper[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [search, setSearch]   = useState("");
  const [query, setQuery]     = useState(""); // debounced
  const [loading, setLoading] = useState(true);

  // 300 ms debounce
  useEffect(() => {
    const t = setTimeout(() => { setQuery(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPapers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page:     page.toString(),
        pageSize: PAGE_SIZE.toString(),
        ...(query ? { search: query } : {}),
      });
      const res  = await fetch(`/api/my-papers?${params}`);
      const data = await res.json();
      setPapers(data.papers ?? []);
      setTotal(data.total ?? 0);
    } catch { /* 静默 */ }
    finally { setLoading(false); }
  }, [page, query]);

  useEffect(() => { fetchPapers(); }, [fetchPapers]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  async function handleDelete(id: string, title: string) {
    if (!confirm(`确定删除这篇论文的记录吗？\n「${title.slice(0, 60)}」\n\n删除后无法恢复。`)) return;
    try {
      const res = await fetch(`/api/my-papers/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert((data as { error?: string }).error || "删除失败，请重试");
        return;
      }
      fetchPapers();
    } catch {
      alert("删除失败，请重试");
    }
  }

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
              {query ? `没有找到「${query}」相关的论文` : "还没有上传过论文，去上传第一篇吧"}
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
                  onClick={() => router.push(`/paper/${paper.id}`)}
                  className="bg-white rounded-xl border border-gray-100 px-4 py-3.5 hover:border-blue-200 hover:shadow-sm transition-all cursor-pointer group"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-800 text-sm leading-snug group-hover:text-blue-600 transition-colors truncate">
                        {paper.title}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        {formatDate(paper.created_at)}
                        {paper.file_size && (
                          <>
                            <span className="mx-1.5 text-gray-300">·</span>
                            {formatFileSize(paper.file_size)}
                          </>
                        )}
                      </p>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(paper.id, paper.title); }}
                      title="删除"
                      className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50"
                    >
                      🗑
                    </button>
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
                <span className="text-sm text-gray-500">{page} / {totalPages} 页</span>
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
