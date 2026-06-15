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
      { icon: "🔍", label: "生成检索词", href: "/literature-search" },
      { icon: "🧭", label: "概念探索器", href: "/concept-explorer" },
      { icon: "🎯", label: "论文转 PPT", href: "/upload" },
      { icon: "🌐", label: "全文翻译", href: "/upload" },
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

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
    });
  }, []);

  async function handleLogout() {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  function isActive(href: string) {
    if (href === "/upload") {
      return pathname === "/" || pathname === "/upload";
    }
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <aside
      className="flex flex-col w-60 h-full shrink-0"
      style={{ background: "#1E293B" }}
    >
      {/* ── 顶部 Logo ───────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-4">
        <Link
          href="/"
          onClick={onClose}
          className="flex items-center gap-2 group"
        >
          <span className="text-2xl">🔬</span>
          <span className="font-bold text-white text-lg tracking-tight group-hover:text-blue-300 transition-colors">
            易研
          </span>
        </Link>
        {/* 移动端关闭按钮 */}
        {onClose && (
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded md:hidden"
          >
            ✕
          </button>
        )}
      </div>

      {/* ── 新建按钮 ─────────────────────────────────────── */}
      <div className="px-3 mb-4">
        <Link
          href="/upload"
          onClick={onClose}
          className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-sm font-medium text-white border border-slate-600 hover:border-slate-400 hover:bg-slate-700 transition-all"
        >
          <span className="text-base leading-none">+</span>
          <span>新建分析</span>
        </Link>
      </div>

      {/* ── 导航菜单 ─────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-2 space-y-5">
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
                      {/* 左侧蓝色高亮竖线 */}
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
      </nav>

      {/* ── 底部用户信息 ─────────────────────────────────── */}
      <div className="px-2 pb-3 pt-2 border-t border-slate-700">
        {email && (
          <p className="text-xs truncate px-3 mb-1.5" style={{ color: "#94A3B8" }}>
            {email}
          </p>
        )}
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm rounded-lg transition-all"
          style={{ color: "#94A3B8" }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.color = "#F87171";
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.1)";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.color = "#94A3B8";
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          <span>🚪</span>
          <span>退出登录</span>
        </button>
        {/* ICP 备案 */}
        <a
          href="https://beian.miit.gov.cn"
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center text-xs mt-2 transition-colors"
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
