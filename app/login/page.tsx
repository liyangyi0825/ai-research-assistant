"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { Button } from "@/components/ui/button";

// ─── 内部组件：读取 URL 参数（需要 Suspense 包裹）───────────────────────────
function LoginForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const searchParams = useSearchParams();

  // 如果是因为链接过期或失效跳回来的，显示友好提示
  useEffect(() => {
    if (searchParams.get("error") === "auth_failed") {
      setStatus("error");
      setErrorMsg("登录链接已失效或过期，请重新发送");
    }
  }, [searchParams]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return;

    setStatus("loading");
    setErrorMsg("");

    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: trimmedEmail,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?redirectTo=${encodeURIComponent(window.location.pathname)}`,
      },
    });

    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
    } else {
      setStatus("sent");
    }
  }

  return (
    <>
      {status === "sent" ? (
        /* ── 邮件已发送 ── */
        <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
          <div className="text-5xl mb-4">📬</div>
          <h2 className="text-lg font-semibold text-gray-800 mb-2">邮件已发送！</h2>
          <p className="text-sm text-gray-500 mb-1">
            已向 <strong className="text-gray-700">{email}</strong> 发送了登录链接
          </p>
          <p className="text-sm text-gray-400">
            点击邮件里的按钮即可登录，链接 10 分钟内有效
          </p>
          <p className="text-xs text-gray-400 mt-3">没收到？检查一下垃圾邮件</p>
          <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mt-3">
            ⚠️ 请在<strong>同一台设备同一个浏览器</strong>里点击链接，否则无法自动回到当前页面
          </p>
          <button
            className="mt-4 text-sm text-blue-500 hover:underline"
            onClick={() => { setStatus("idle"); }}
          >
            重新发送
          </button>
        </div>
      ) : (
        /* ── 输入邮箱 ── */
        <form onSubmit={handleSend} className="bg-white rounded-2xl p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-800 mb-1">登录 / 注册</h2>
          <p className="text-sm text-gray-500 mb-2">
            输入邮箱，我们发给你一个一键登录链接，无需密码
          </p>
          <p className="text-xs text-gray-400 mb-5">
            点击邮件中的链接后会自动回到当前页面
          </p>

          <div className="space-y-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              disabled={status === "loading"}
              className="w-full rounded-xl border border-gray-200 px-4 py-3 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
            />

            {status === "error" && (
              <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                ❌ {errorMsg}
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={status === "loading" || !email.trim()}
            >
              {status === "loading" ? "发送中..." : "发送登录链接"}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

// ─── 页面外壳：提供 Suspense 边界 ────────────────────────────────────────────
export default function LoginPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <span className="text-5xl">🔬</span>
          <h1 className="mt-3 text-2xl font-bold text-gray-800">AI 科研助手</h1>
          <p className="mt-1 text-sm text-gray-500">帮你更高效地读论文</p>
        </div>

        <Suspense fallback={<div className="bg-white rounded-2xl p-8 shadow-sm text-center text-gray-400">加载中...</div>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
