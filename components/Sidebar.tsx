"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

const NAV_GROUPS = [
  {
    label: "功能",
    items: [
      { icon: "📄", label: "上传论文", href: "/upload" },
      { icon: "💬", label: "与论文对话", href: "/upload" },
      { icon: "🌐", label: "全文翻译", href: "/translate" },
      { icon: "🔍", label: "生成检索词", href: "/literature-search" },
      { icon: "🧭", label: "概念探索器", href: "/concept-explorer" },
      { icon: "🎯", label: "论文转 PPT", href: "/ppt" },
    ],
  },
  {
    label: "我的",
    items: [
      { icon: "👤", label: "我的科研档案", href: "/my-profile" },
      { icon: "📝", label: "我的研究笔记", href: "/my-notes" },
    ],
  },
];

interface RecentPaper {
  id: string;
  title: string;
  created_at: string;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return "刚刚";
  if (hours < 1)  return `${mins}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days  === 1) return "昨天";
  if (days  < 7)  return `${days}天前`;
  if (days  < 30) return `${Math.floor(days / 7)}周前`;
  return `${Math.floor(days / 30)}个月前`;
}

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const pathname = usePathname();
  const [email, setEmail]               = useState<string | null>(null);
  const [recentPapers, setRecentPapers] = useState<RecentPaper[]>([]);

  // 获取登录用户
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
    });
  }, []);

  // 路由切换时重新拉取近期论文（pathname 变化 = 用户导航了）
  useEffect(() => {
    fetch("/api/my-papers?limit=5")
      .then(r => r.json())
      .then(d => setRecentPapers(d.papers ?? []))
      .catch(() => { /* 静默失败 */ });
  }, [pathname]);

  async function handleLogout() {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  function openFeedback() {
    window.dispatchEvent(new Event("open-feedback"));
    onClose?.();
  }

  function isActive(href: string) {
    if (href === "/upload") {
      return pathname === "/" || pathname === "/upload" || pathname.startsWith("/upload?");
    }
    return pathname === href || pathname.startsWith(href + "/");
  }

  const avatarLetter = email ? email[0].toUpperCase() : "U";

  return (
    <aside
      className="flex flex-col w-60 h-full shrink-0"
      style={{ background: "#1E293B" }}
    >
      {/* ── 顶部 Logo ───────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-4">
        <Link href="/" onClick={onClose} className="flex items-center gap-2 group">
          <span className="text-2xl">🔬</span>
          <span className="font-bold text-white text-lg tracking-tight group-hover:text-blue-300 transition-colors">
            易研
          </span>
        </Link>
        {onClose && (
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded md:hidden">
            ✕
          </button>
        )}
      </div>

      {/* ── 新建按钮 ─────────────────────────────────────── */}
      <div className="px-3 mb-2">
        <Link
          href="/upload"
          onClick={onClose}
          className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-sm font-medium text-white border border-slate-600 hover:border-slate-400 hover:bg-slate-700 transition-all"
        >
          <span className="text-base leading-none">+</span>
          <span>新建分析</span>
        </Link>
      </div>

      {/* ── 导航菜单（含近期论文）────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-2 space-y-4 pb-2">

        {/* 近期论文 */}
        {recentPapers.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider px-3 mb-1" style={{ color: "#64748B" }}>
              近期论文
            </p>
            <ul className="space-y-0.5">
              {recentPapers.map((paper) => (
                <li key={paper.id}>
                  <Link
                    href={`/paper/${paper.id}`}
                    onClick={onClose}
                    className="flex flex-col px-3 py-2 rounded-lg transition-all hover:bg-slate-700/60 group"
                  >
                    <span className="text-xs text-slate-300 truncate leading-snug group-hover:text-white">
                      {paper.title}
                    </span>
                    <span className="text-[10px] mt-0.5" style={{ color: "#475569" }}>
                      {formatRelativeTime(paper.created_at)}
                    </span>
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href="/my-papers"
                  onClick={onClose}
                  className="flex items-center px-3 py-1.5 rounded-lg text-xs transition-all hover:bg-slate-700/60 hover:text-slate-300"
                  style={{ color: "#475569" }}
                >
                  查看全部 →
                </Link>
              </li>
            </ul>
          </div>
        )}

        {/* 功能导航组 */}
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="text-xs font-semibold uppercase tracking-wider px-3 mb-1.5" style={{ color: "#64748B" }}>
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <li key={item.label}>
                    <Link
                      href={item.href}
                      onClick={onClose}
                      className={`relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all ${
                        active
                          ? "bg-slate-700 text-white font-medium"
                          : "text-slate-300 hover:bg-slate-700/60 hover:text-white"
                      }`}
                    >
                      {active && (
                        <span
                          className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r"
                          style={{ background: "#3B82F6" }}
                        />
                      )}
                      <span className="text-base leading-none">{item.icon}</span>
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {/* 其他 */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider px-3 mb-1.5" style={{ color: "#64748B" }}>
            其他
          </p>
          <ul className="space-y-0.5">
            <li>
              <button
                onClick={openFeedback}
                className="relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all w-full text-left text-slate-300 hover:bg-slate-700/60 hover:text-white"
              >
                <span className="text-base leading-none">💬</span>
                <span>意见反馈</span>
              </button>
            </li>
            <li>
              <Link
                href="/help"
                onClick={onClose}
                className={`relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all ${
                  pathname === "/help"
                    ? "bg-slate-700 text-white font-medium"
                    : "text-slate-300 hover:bg-slate-700/60 hover:text-white"
                }`}
              >
                {pathname === "/help" && (
                  <span
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r"
                    style={{ background: "#3B82F6" }}
                  />
                )}
                <span className="text-base leading-none">❓</span>
                <span>帮助中心</span>
              </Link>
            </li>
          </ul>
        </div>
      </nav>

      {/* ── 底部用户信息 ─────────────────────────────────── */}
      <div className="px-2 pb-3 pt-2 border-t border-slate-700">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <div
            className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-sm font-bold text-white"
            style={{ background: "#3B82F6" }}
          >
            {avatarLetter}
          </div>
          <p className="text-xs truncate flex-1" style={{ color: "#94A3B8" }}>
            {email ?? "未登录"}
          </p>
          <button
            onClick={handleLogout}
            className="shrink-0 text-xs transition-colors"
            style={{ color: "#64748B" }}
            onMouseEnter={e => (e.currentTarget.style.color = "#F87171")}
            onMouseLeave={e => (e.currentTarget.style.color = "#64748B")}
          >
            退出登录
          </button>
        </div>
        <a
          href="https://beian.miit.gov.cn"
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center text-xs mt-1.5 transition-colors"
          style={{ color: "#334155" }}
          onMouseEnter={e => (e.currentTarget.style.color = "#64748B")}
          onMouseLeave={e => (e.currentTarget.style.color = "#334155")}
        >
          津ICP备2026007356号
        </a>
      </div>
    </aside>
  );
}
