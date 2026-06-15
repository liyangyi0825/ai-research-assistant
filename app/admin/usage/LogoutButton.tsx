"use client";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

export function AdminLogoutButton() {
  async function handleLogout() {
    const sb = getSupabaseBrowserClient();
    await sb.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <button
      onClick={handleLogout}
      className="text-sm transition-colors"
      style={{ color: "#64748B" }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "#F87171")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "#64748B")}
    >
      退出登录
    </button>
  );
}
