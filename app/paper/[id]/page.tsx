// 论文详情页 / 分析入口
// 路径：/paper/[id]
// 从数据库加载论文，展示元信息和内容预览，提供 AI 分析功能入口

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseAuthClient } from "@/lib/supabase";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    timeZone:    "Asia/Shanghai",
    year:        "numeric",
    month:       "2-digit",
    day:         "2-digit",
    hour:        "2-digit",
    minute:      "2-digit",
  });
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function PaperPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await getSupabaseAuthClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: paper, error } = await supabase
    .from("papers")
    .select("id, title, content, file_size, created_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error || !paper) redirect("/my-papers");

  const preview = paper.content ? (paper.content as string).slice(0, 500) : null;
  const hasMore = (paper.content?.length ?? 0) > 500;

  const FEATURES = [
    { icon: "✨", label: "AI 论文总结",  desc: "生成研究要点速览" },
    { icon: "💬", label: "与论文对话",   desc: "基于全文自由提问" },
    { icon: "🌐", label: "全文对照翻译", desc: "中英并排对照阅读" },
    { icon: "🎯", label: "论文转 PPT",   desc: "一键生成演示文稿" },
  ];

  return (
    <div className="min-h-full" style={{ background: "#F8FAFC" }}>
      <div className="max-w-2xl mx-auto px-4 py-8">

        {/* 返回 */}
        <Link
          href="/my-papers"
          className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 mb-6 transition-colors"
        >
          ← 返回论文列表
        </Link>

        {/* 标题 + 元信息 */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-5 mb-4">
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0"
              style={{ background: "#EFF6FF" }}
            >
              📄
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-bold text-gray-800 leading-snug">{paper.title}</h1>
              <p className="text-xs text-gray-400 mt-1.5">
                上传于 {formatDate(paper.created_at)}
                {paper.file_size && (
                  <span className="ml-2.5">· {formatFileSize(paper.file_size)}</span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* 内容预览 */}
        {preview && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-4 mb-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">论文内容预览</p>
            <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">
              {preview}
              {hasMore && <span className="text-gray-300"> …（共 {paper.content?.length.toLocaleString()} 字符）</span>}
            </p>
          </div>
        )}

        {/* 功能卡片 */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-4 mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">可用功能</p>
          <div className="grid grid-cols-2 gap-3">
            {FEATURES.map((f) => (
              <Link
                key={f.label}
                href={`/upload?paper=${id}`}
                className="flex items-start gap-3 p-3 rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50/50 transition-all group"
              >
                <span className="text-xl shrink-0 mt-0.5">{f.icon}</span>
                <div>
                  <p className="text-sm font-medium text-gray-800 group-hover:text-blue-700 transition-colors leading-snug">
                    {f.label}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{f.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* 主 CTA */}
        <Link
          href={`/upload?paper=${id}`}
          className="flex items-center justify-center gap-2 w-full py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
          style={{ background: "#3B82F6" }}
        >
          开始分析此论文 →
        </Link>

      </div>
    </div>
  );
}
