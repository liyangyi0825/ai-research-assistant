"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// 解析 AI 返回的结构化总结，拆成四个部分
function parseSummary(text: string) {
  const sections = [
    { key: "研究问题", icon: "🔍" },
    { key: "研究方法", icon: "🔬" },
    { key: "主要结论", icon: "📊" },
    { key: "创新点",   icon: "💡" },
  ];

  return sections.map(({ key, icon }) => {
    const regex = new RegExp(`【${key}】([\\s\\S]*?)(?=【|$)`);
    const match = text.match(regex);
    const content = match ? match[1].trim() : "（未能提取该部分）";
    return { key, icon, content };
  });
}

export default function UploadPage() {
  // PDF 提取状态
  const [extractStatus, setExtractStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [extractedText, setExtractedText] = useState("");
  const [extractError, setExtractError] = useState("");
  const [fileName, setFileName] = useState("");

  // AI 总结状态
  const [summaryStatus, setSummaryStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [summaryText, setSummaryText] = useState("");
  const [summaryError, setSummaryError] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ——— PDF 上传与提取 ———
  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setExtractStatus("error");
      setExtractError("请上传 PDF 格式的文件");
      return;
    }

    setFileName(file.name);
    setExtractStatus("loading");
    setExtractError("");
    setSummaryStatus("idle");
    setSummaryText("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/extract", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "解析失败");

      setExtractedText(data.text);
      setExtractStatus("done");
    } catch (err) {
      setExtractStatus("error");
      setExtractError(err instanceof Error ? err.message : "上传失败，请重试");
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  function handleReset() {
    setExtractStatus("idle");
    setExtractedText("");
    setExtractError("");
    setFileName("");
    setSummaryStatus("idle");
    setSummaryText("");
    setSummaryError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ——— 调用 AI 生成总结 ———
  async function handleSummarize() {
    setSummaryStatus("loading");
    setSummaryError("");

    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: extractedText }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "总结失败");

      setSummaryText(data.summary);
      setSummaryStatus("done");
    } catch (err) {
      setSummaryStatus("error");
      setSummaryError(err instanceof Error ? err.message : "生成失败，请重试");
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      {/* 顶部导航 */}
      <header className="w-full px-6 py-4 flex items-center justify-between bg-white/70 backdrop-blur border-b border-gray-200">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-2xl">🔬</span>
          <span className="font-bold text-lg text-gray-800">AI 科研助手</span>
        </Link>
        <span className="text-sm text-gray-500">上传论文</span>
      </header>

      <main className="flex-1 flex flex-col items-center px-6 py-12">
        <div className="w-full max-w-3xl space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 mb-1">上传 PDF 论文</h1>
            <p className="text-gray-500">上传后 AI 将自动生成结构化中文总结</p>
          </div>

          {/* ===== 上传区域 ===== */}
          {(extractStatus === "idle" || extractStatus === "error") && (
            <div
              className="bg-white rounded-2xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors p-12 text-center cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
            >
              <div className="text-5xl mb-4">📄</div>
              <p className="text-lg font-medium text-gray-700 mb-2">
                点击选择文件，或将 PDF 拖拽到这里
              </p>
              <p className="text-sm text-gray-400">仅支持 PDF 格式，最大 20MB</p>

              {extractStatus === "error" && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                  ❌ {extractError}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={handleInputChange}
              />
            </div>
          )}

          {/* ===== PDF 解析中 ===== */}
          {extractStatus === "loading" && (
            <div className="bg-white rounded-2xl p-12 text-center shadow-sm">
              <div className="text-5xl mb-4 animate-bounce">⏳</div>
              <p className="text-lg font-medium text-gray-700">
                正在解析 <span className="text-blue-600">{fileName}</span> ...
              </p>
              <p className="text-sm text-gray-400 mt-2">通常需要几秒钟</p>
            </div>
          )}

          {/* ===== PDF 解析完成 ===== */}
          {extractStatus === "done" && (
            <>
              {/* 文件信息 + 操作按钮 */}
              <div className="bg-white rounded-2xl p-5 shadow-sm flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-800">✅ {fileName}</p>
                  <p className="text-sm text-gray-400 mt-0.5">
                    已提取 {extractedText.length.toLocaleString()} 个字符
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={handleReset}>
                  重新上传
                </Button>
              </div>

              {/* ===== AI 总结区域 ===== */}
              {summaryStatus === "idle" && (
                <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-blue-100">
                  <div className="text-4xl mb-3">✨</div>
                  <h2 className="text-lg font-semibold text-gray-800 mb-2">
                    让 AI 为你总结这篇论文
                  </h2>
                  <p className="text-sm text-gray-500 mb-5">
                    将生成研究问题、方法、结论、创新点四个部分的结构化总结
                  </p>
                  <Button size="lg" onClick={handleSummarize}>
                    生成 AI 总结
                  </Button>
                </div>
              )}

              {summaryStatus === "loading" && (
                <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
                  <div className="text-5xl mb-4 animate-spin">⚙️</div>
                  <p className="text-lg font-medium text-gray-700">
                    AI 正在阅读论文并生成总结...
                  </p>
                  <p className="text-sm text-gray-400 mt-2">通常需要 10～30 秒</p>
                </div>
              )}

              {summaryStatus === "error" && (
                <div className="bg-white rounded-2xl p-6 shadow-sm">
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm mb-4">
                    ❌ {summaryError}
                  </div>
                  <Button onClick={handleSummarize}>重试</Button>
                </div>
              )}

              {summaryStatus === "done" && (
                <div className="space-y-4">
                  <h2 className="text-xl font-bold text-gray-800">📋 AI 论文总结</h2>
                  {parseSummary(summaryText).map(({ key, icon, content }) => (
                    <div
                      key={key}
                      className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
                    >
                      <h3 className="font-semibold text-gray-800 mb-3">
                        {icon} {key}
                      </h3>
                      <p className="text-gray-700 text-sm leading-relaxed whitespace-pre-wrap">
                        {content}
                      </p>
                    </div>
                  ))}
                  <Button variant="outline" className="w-full" onClick={handleSummarize}>
                    重新生成总结
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
