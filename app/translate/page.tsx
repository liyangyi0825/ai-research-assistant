"use client";

import { useState, useRef } from "react";
import { PdfTranslationView } from "@/components/PdfTranslationView";
import { Header } from "@/components/Header";

type Stage = "idle" | "error";

export default function TranslatePage() {
  const [stage, setStage]     = useState<Stage>("idle");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [error, setError]     = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("请上传 PDF 格式的文件");
      setStage("error");
      return;
    }
    setError("");
    setPdfFile(file);
  }

  function handleReset() {
    setPdfFile(null);
    setStage("idle");
    setError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // PDF 选好后直接进入阅读/翻译视图
  if (pdfFile) {
    return <PdfTranslationView file={pdfFile} onBack={handleReset} />;
  }

  return (
    <div className="min-h-full bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="全文翻译" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-12">
        <div className="w-full max-w-2xl space-y-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">🌐 全文对照翻译</h1>
            <p className="text-sm sm:text-base text-gray-500">
              上传 PDF 论文，左边显示原文，右边显示 AI 翻译，两侧同步滚动
            </p>
          </div>

          {/* 上传区 */}
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
        </div>
      </main>
    </div>
  );
}
