"use client";

import { useState, useEffect } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { Button } from "@/components/ui/button";

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  ) : (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  );
}

export default function ResetPasswordPage() {
  const [password,        setPassword]        = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPwd,         setShowPwd]         = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);
  const [status,  setStatus]  = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error,   setError]   = useState("");
  const [ready,   setReady]   = useState(false); // 是否有有效 session

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    // 检查当前是否有 session（auth/callback 已帮我们交换 token 并设置 cookie）
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setReady(true);
    });

    // 兼容：监听 PASSWORD_RECOVERY 事件（某些客户端流程会触发）
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8)          { setError("密码至少需要 8 位"); return; }
    if (password !== confirmPassword)  { setError("两次输入的密码不一致"); return; }

    setStatus("loading"); setError("");
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.auth.updateUser({ password });

    if (err) {
      setStatus("error");
      setError(err.message);
    } else {
      setStatus("success");
      setTimeout(() => { window.location.href = "/"; }, 2000);
    }
  }

  const inputCls = "w-full rounded-xl border border-gray-200 px-4 py-3 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-50";

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">

        <div className="text-center mb-8">
          <span className="text-5xl">🔬</span>
          <h1 className="mt-3 text-2xl font-bold text-gray-800">AI 科研助手</h1>
        </div>

        <div className="bg-white rounded-2xl p-8 shadow-sm">
          {status === "success" ? (
            <div className="text-center">
              <div className="text-5xl mb-4">✅</div>
              <h2 className="text-lg font-semibold text-gray-800">密码已重置</h2>
              <p className="text-sm text-gray-500 mt-2">正在跳转到首页…</p>
            </div>
          ) : !ready ? (
            <div className="text-center text-gray-400">
              <p className="text-sm">验证中…</p>
              <p className="text-xs mt-2 text-gray-300">如果长时间无响应，请重新点击邮件中的链接</p>
            </div>
          ) : (
            <form onSubmit={handleReset} className="space-y-3">
              <h2 className="text-base font-semibold text-gray-800 mb-1">设置新密码</h2>
              <p className="text-sm text-gray-500 mb-4">请输入你的新密码（至少 8 位）</p>

              <div className="relative">
                <input type={showPwd ? "text" : "password"} value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="新密码（至少 8 位）" required disabled={status === "loading"}
                  className={inputCls + " pr-12"} />
                <button type="button" onClick={() => setShowPwd(!showPwd)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <EyeIcon open={showPwd} />
                </button>
              </div>

              <div className="relative">
                <input type={showConfirm ? "text" : "password"} value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="再次输入新密码" required disabled={status === "loading"}
                  className={inputCls + " pr-12"} />
                <button type="button" onClick={() => setShowConfirm(!showConfirm)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <EyeIcon open={showConfirm} />
                </button>
              </div>

              {(status === "error" || error) && (
                <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  ❌ {error}
                </p>
              )}

              <Button type="submit" size="lg" className="w-full"
                disabled={status === "loading" || !password || !confirmPassword}>
                {status === "loading" ? "设置中…" : "确认设置新密码"}
              </Button>
            </form>
          )}
        </div>

      </div>
    </div>
  );
}
