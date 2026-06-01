"use client";

// 共享顶部导航栏
// 显示：Logo | 页面标题（可选）| 当前登录邮箱 + 退出按钮
// 用于首页和上传页

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

interface HeaderProps {
  /** 右侧显示的页面标题文字（如"上传论文"），不传则显示副标题 */
  title?: string;
}

export function Header({ title }: HeaderProps) {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    // 获取当前登录用户
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
    });
  }, []);

  async function handleLogout() {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    // 退出后跳到登录页
    window.location.href = "/login";
  }

  return (
    <header className="w-full px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between bg-white/70 backdrop-blur border-b border-gray-200">
      {/* 左侧：Logo */}
      <Link href="/" className="flex items-center gap-2">
        <span className="text-2xl">🔬</span>
        <span className="font-bold text-lg text-gray-800">AI 科研助手</span>
      </Link>

      {/* 右侧：页面标题或用户信息 */}
      <div className="flex items-center gap-3">
        {title && (
          <span className="hidden sm:block text-sm text-gray-500">{title}</span>
        )}
        {email && (
          <>
            <span className="text-sm text-gray-500 max-w-[120px] sm:max-w-[180px] truncate">
              {email}
            </span>
            <button
              onClick={handleLogout}
              className="text-sm text-gray-500 hover:text-red-500 transition-colors px-2 py-1 rounded-lg hover:bg-red-50"
            >
              退出
            </button>
          </>
        )}
      </div>
    </header>
  );
}
