"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";

const MIN_LEN = 10;
const MAX_LEN = 500;

export function FeedbackWidget() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    function onOpenFeedback() { setIsOpen(true); }
    window.addEventListener("open-feedback", onOpenFeedback);
    return () => window.removeEventListener("open-feedback", onOpenFeedback);
  }, []);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const remaining = MAX_LEN - message.length;
  const tooShort = message.trim().length > 0 && message.trim().length < MIN_LEN;
  const tooLong = message.length > MAX_LEN;
  const canSubmit = message.trim().length >= MIN_LEN && !tooLong && status !== "loading";

  function handleClose() {
    if (status === "loading") return;
    setIsOpen(false);
    setTimeout(() => {
      setMessage("");
      setEmail("");
      setScreenshot(null);
      setStatus("idle");
      setErrorMsg("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }, 200);
  }

  async function handleSubmit() {
    if (!canSubmit) return;

    setStatus("loading");
    setErrorMsg("");

    try {
      const formData = new FormData();
      formData.append("message", message.trim());
      if (email.trim()) formData.append("email", email.trim());
      if (screenshot) formData.append("screenshot", screenshot);
      formData.append("pageUrl", window.location.href);

      const res = await fetch("/api/feedback", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "提交失败");

      setStatus("success");
      setTimeout(() => handleClose(), 2000);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "提交失败，请重试");
    }
  }

  return (
    <>
      {/* ===== 蒙层 + 弹窗 ===== */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        >
          <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden">

            {/* 标题栏 */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-800">💬 提交反馈</h2>
              <button
                onClick={handleClose}
                className="w-10 h-10 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors text-2xl leading-none"
                aria-label="关闭"
              >
                ×
              </button>
            </div>

            {/* ===== 成功状态 ===== */}
            {status === "success" ? (
              <div className="px-5 py-12 text-center">
                <div className="text-5xl mb-4">✅</div>
                <p className="text-lg font-semibold text-gray-800">感谢你的反馈！</p>
                <p className="text-sm text-gray-500 mt-1">我们会认真阅读并持续改进</p>
              </div>
            ) : (
              /* ===== 表单 ===== */
              <div className="px-5 py-5 space-y-4 max-h-[80vh] overflow-y-auto">

                {/* 反馈内容（必填）*/}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-sm font-medium text-gray-700">
                      反馈内容 <span className="text-red-400">*</span>
                    </label>
                    <span className={`text-xs ${tooLong ? "text-red-500 font-medium" : "text-gray-400"}`}>
                      {remaining < 0 ? `超出 ${-remaining} 字` : `还可输入 ${remaining} 字`}
                    </span>
                  </div>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="描述你遇到的问题，或对产品的建议……"
                    rows={4}
                    disabled={status === "loading"}
                    className={`w-full rounded-xl border px-3 py-2.5 text-base outline-none focus:ring-2 resize-none disabled:opacity-50 transition-colors ${
                      tooLong
                        ? "border-red-300 focus:border-red-400 focus:ring-red-100"
                        : "border-gray-200 focus:border-blue-400 focus:ring-blue-100"
                    }`}
                  />
                  {tooShort && (
                    <p className="mt-1 text-xs text-orange-500">至少需要 {MIN_LEN} 个字（还差 {MIN_LEN - message.trim().length} 个）</p>
                  )}
                </div>

                {/* 截图上传（可选）*/}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    截图 <span className="text-gray-400 font-normal">（可选，最大 5 MB）</span>
                  </label>
                  {screenshot ? (
                    <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-xl border border-gray-200">
                      <span className="text-lg">🖼️</span>
                      <span className="text-sm text-gray-600 flex-1 truncate">{screenshot.name}</span>
                      <button
                        onClick={() => { setScreenshot(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                        className="text-xs text-gray-400 hover:text-red-500 transition-colors px-1"
                      >
                        删除
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={status === "loading"}
                      className="w-full py-3 rounded-xl border-2 border-dashed border-gray-200 hover:border-blue-300 text-sm text-gray-400 hover:text-blue-500 transition-colors disabled:opacity-50"
                    >
                      📎 点击上传截图
                    </button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) setScreenshot(f); }}
                  />
                </div>

                {/* 邮箱（可选）*/}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    你的邮箱 <span className="text-gray-400 font-normal">（可选，方便我们回复）</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="example@qq.com"
                    disabled={status === "loading"}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                  />
                </div>

                {/* 错误提示 */}
                {status === "error" && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                    ❌ {errorMsg}
                  </div>
                )}

                {/* 提交按钮 */}
                <Button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  size="lg"
                  className="w-full"
                >
                  {status === "loading" ? "提交中…" : "提交反馈"}
                </Button>

                <p className="text-xs text-center text-gray-400 pb-1">
                  反馈内容仅用于产品改进，不会公开
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
