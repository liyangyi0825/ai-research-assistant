"use client";

import { useState, useRef } from "react";
import { TranslationView } from "@/components/TranslationView";
import { Header } from "@/components/Header";

function DotLoader() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" />
    </span>
  );
}

type Stage = "idle" | "loading" | "done" | "error";

export default function TranslatePage() {
  const [stage, setStage] = useState<Stage>("idle");
  const [uploadStage, setUploadStage] = useState<"uploading" | "extracting">("uploading");
  const [extractedText, setExtractedText] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("请上传 PDF 格式的文件");
      setStage("error");
      return;
    }
    setFileName(file.name);
    setError("");
    setStage("loading");
    setUploadStage("uploading");

    const stageTimer = setTimeout(() => setUploadStage("extracting"), 1500);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: formData });
      clearTimeout(stageTimer);

      let data: { text?: string; error?: string };
      try {
        data = await res.json();
      } catch {
        if (res.status === 413) throw new Error("PDF 文件太大（最大 50MB），请压缩后重试");
        throw new Error(`服务器错误（HTTP ${res.status}）`);
      }
      if (!res.ok) throw new Error(data.error || "解析失败");
      setExtractedText(data.text ?? "");
      setStage("done");
    } catch (err) {
      clearTimeout(stageTimer);
      setError(err instanceof Error ? err.message : "上传失败，请重试");
      setStage("error");
    }
  }

  function handleReset() {
    setStage("idle");
    setExtractedText("");
    setFileName("");
    setError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // 翻译视图：全屏接管
  if (stage === "done" && extractedText) {
    return (
      <TranslationView
        extractedText={extractedText}
        onBack={handleReset}
        backLabel="← 重新上传"
      />
    );
  }

  return (
    <div className="min-h-full bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="全文翻译" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-12">
        <div className="w-full max-w-2xl space-y-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">🌐 全文对照翻译</h1>
            <p className="text-sm sm:text-base text-gray-500">
              上传 PDF 论文，AI 逐段翻译，原文与译文左右对照显示
            </p>
          </div>

          {/* 提示说明 */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
            <span className="font-medium">📌 说明：</span>
            直接上传 PDF 即可开始翻译，无需先生成论文总结，也不消耗总结额度。
          </div>

          {/* 上传区 */}
          {(stage === "idle" || stage === "error") && (
            <div
              className="bg-white rounded-2xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors p-8 sm:p-12 text-center cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
              onDragOver={(e) => e.preventDefault()}
            >
              <div className="text-5xl mb-3">🌐</div>
              <p className="text-base sm:text-lg font-medium text-gray-700 mb-2">
                点击选择文件，或拖拽 PDF 到这里
              </p>
              <p className="text-sm text-gray-400">支持 PDF 格式，最大 50MB</p>
              {stage === "error" && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                  ❌ {error}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
            </div>
          )}

          {/* 上传中 */}
          {stage === "loading" && (
            <div className="bg-white rounded-2xl p-8 sm:p-12 text-center shadow-sm">
              <div className="text-5xl mb-5">
                {uploadStage === "uploading" ? "📤" : "📄"}
              </div>
              <div className="flex items-center justify-center gap-2 mb-4">
                <div className={`flex items-center gap-1.5 text-sm font-medium ${uploadStage === "uploading" ? "text-blue-600" : "text-green-500"}`}>
                  {uploadStage === "uploading" ? <DotLoader /> : <span>✓</span>}
                  <span>正在上传</span>
                </div>
                <span className="text-gray-300">→</span>
                <div className={`flex items-center gap-1.5 text-sm font-medium ${uploadStage === "extracting" ? "text-blue-600" : "text-gray-300"}`}>
                  {uploadStage === "extracting" && <DotLoader />}
                  <span>提取文字</span>
                </div>
              </div>
              <p className="text-sm text-gray-400 truncate px-4">{fileName}</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
