"use client";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Sidebar } from "./Sidebar";

// 这些路径不显示侧边栏
const AUTH_PATHS = ["/login", "/auth", "/reset-password", "/admin"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const isAuthPage = AUTH_PATHS.some((p) => pathname.startsWith(p));

  // 登录/注册页面不加侧边栏
  if (isAuthPage) return <>{children}</>;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "#F8FAFC" }}>
      {/* ── 桌面端固定侧边栏 ─────────────────────────── */}
      <div className="hidden md:flex h-full">
        <Sidebar />
      </div>

      {/* ── 移动端侧边栏覆盖层 ───────────────────────── */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <Sidebar onClose={() => setSidebarOpen(false)} />
          {/* 点击空白区域收起 */}
          <div
            className="flex-1"
            style={{ background: "rgba(0,0,0,0.45)" }}
            onClick={() => setSidebarOpen(false)}
          />
        </div>
      )}

      {/* ── 主内容区 ─────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* 移动端顶部栏（仅小屏显示） */}
        <div
          className="md:hidden flex items-center gap-3 px-4 py-3 border-b"
          style={{ background: "#1E293B", borderColor: "#334155" }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-slate-300 hover:text-white text-xl leading-none"
            aria-label="打开菜单"
          >
            ☰
          </button>
          <span className="font-bold text-white text-lg">易研</span>
        </div>

        {/* 页面内容（可滚动） */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
