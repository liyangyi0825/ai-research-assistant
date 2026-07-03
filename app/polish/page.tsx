"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { PolishDiffView } from "@/components/PolishDiffView";

type Language = "zh" | "en";
type Discipline = "general" | "science" | "social_science" | "humanities" | "medical" | "business";
type Intensity = "light" | "medium" | "deep";
type Stage = "idle" | "loading" | "done" | "error";

const MAX_CHARS = 15000;

const DISCIPLINE_OPTIONS: { value: Discipline; label: string }[] = [
  { value: "general", label: "通用" },
  { value: "science", label: "理工科" },
  { value: "social_science", label: "社科" },
  { value: "humanities", label: "人文" },
  { value: "medical", label: "医学" },
  { value: "business", label: "商科经管" },
];

const INTENSITY_OPTIONS: { value: Intensity; label: string; desc: string }[] = [
  { value: "light", label: "轻度", desc: "仅修正语法错误" },
  { value: "medium", label: "中度", desc: "优化表达+句式" },
  { value: "deep", label: "深度", desc: "全面改写提升" },
];

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
        active
          ? "bg-blue-500 text-white shadow-sm"
          : "bg-white text-gray-600 border border-gray-200 hover:border-blue-300"
      }`}
    >
      {children}
    </button>
  );
}

export default function PolishPage() {
  const [text, setText] = useState("");
  const [language, setLanguage] = useState<Language>("zh");
  const [discipline, setDiscipline] = useState<Discipline>("general");
  const [intensity, setIntensity] = useState<Intensity>("medium");

  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [copyDone, setCopyDone] = useState(false);

  const overLimit = text.length > MAX_CHARS;
  const canSubmit = text.trim().length > 0 && !overLimit && stage !== "loading";

  async function handlePolish() {
    if (!canSubmit) return;
    setStage("loading");
    setResult("");
    setError("");
    setShowDiff(false);
    setCopyDone(false);

    try {
      const res = await fetch("/api/polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language, discipline, intensity }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "润色失败，请重试");
      }
      if (!res.body) throw new Error("服务器响应为空");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            const evt = JSON.parse(raw) as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              fullText += evt.delta.text ?? "";
              setResult(fullText);
            }
          } catch { /* skip malformed SSE */ }
        }
      }

      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "润色失败，请重试");
      setStage("error");
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(result).catch(() => {});
    setCopyDone(true);
    setTimeout(() => setCopyDone(false), 2000);
  }

  const resultReady = stage === "done" && result.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="论文润色" />

      <main className="flex-1 px-4 sm:px-6 py-6 sm:py-12 pb-24 sm:pb-12">
        <div className="max-w-6xl mx-auto space-y-5">
          {/* 标题 */}
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">✍️ 论文润色</h1>
            <p className="text-sm sm:text-base text-gray-500">
              提升学术写作质量，优化语言表达与逻辑结构
            </p>
          </div>

          {/* 设置区域 */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-semibold text-gray-500 w-20 shrink-0">语言</span>
              <div className="flex gap-2">
                <SegButton active={language === "zh"} onClick={() => setLanguage("zh")}>中文论文</SegButton>
                <SegButton active={language === "en"} onClick={() => setLanguage("en")}>English Paper</SegButton>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-semibold text-gray-500 w-20 shrink-0">学科领域</span>
              <select
                value={discipline}
                onChange={(e) => setDiscipline(e.target.value as Discipline)}
                className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 bg-white text-gray-700 outline-none focus:border-blue-400 transition-colors"
              >
                {DISCIPLINE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-semibold text-gray-500 w-20 shrink-0">润色强度</span>
              <div className="flex flex-wrap gap-2">
                {INTENSITY_OPTIONS.map((opt) => (
                  <SegButton key={opt.value} active={intensity === opt.value} onClick={() => setIntensity(opt.value)}>
                    {opt.label}
                    <span className="hidden sm:inline text-xs opacity-80 ml-1">（{opt.desc}）</span>
                  </SegButton>
                ))}
              </div>
            </div>
          </div>

          {/* 输入 / 输出 区域 */}
          <div className="grid md:grid-cols-2 gap-4">
            {/* 左：输入 */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
              <div className="px-4 py-2.5 border-b border-gray-100">
                <h2 className="font-semibold text-gray-800 text-sm">原文</h2>
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="在此粘贴您的论文内容..."
                className="flex-1 min-h-[360px] p-4 text-sm text-gray-700 leading-relaxed outline-none resize-none"
              />
              <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-between">
                <span className={`text-xs ${overLimit ? "text-red-500 font-medium" : "text-gray-400"}`}>
                  {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()} 字
                </span>
                {overLimit && (
                  <span className="text-xs text-red-500">内容超过{MAX_CHARS}字限制，请分段润色</span>
                )}
              </div>
            </div>

            {/* 右：输出 */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
              <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between">
                <h2 className="font-semibold text-gray-800 text-sm">
                  {showDiff ? "修改对比" : "润色结果"}
                </h2>
                {stage === "loading" && (
                  <span className="text-xs text-blue-500 flex items-center gap-1.5">
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                    润色中…
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-[360px] p-4 overflow-auto">
                {stage === "error" ? (
                  <p className="text-sm text-red-500">❌ {error}</p>
                ) : !result && stage === "idle" ? (
                  <p className="text-sm text-gray-300">润色后的内容将显示在这里…</p>
                ) : showDiff ? (
                  <PolishDiffView original={text} revised={result} language={language} />
                ) : (
                  <div className="whitespace-pre-wrap text-sm text-gray-700 leading-relaxed">{result}</div>
                )}
              </div>
            </div>
          </div>

          {/* 底部操作 */}
          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              onClick={handlePolish}
              disabled={!canSubmit}
              size="lg"
              className="flex-1 text-base"
            >
              {stage === "loading" ? "润色中…" : "开始润色"}
            </Button>
            <Button
              variant="outline"
              onClick={handleCopy}
              disabled={!resultReady}
              className="sm:w-40"
            >
              {copyDone ? "✓ 已复制" : "复制结果"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowDiff((v) => !v)}
              disabled={!resultReady}
              className="sm:w-48"
            >
              {showDiff ? "查看润色结果" : "查看修改对比"}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
