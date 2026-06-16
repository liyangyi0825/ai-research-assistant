"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";

type UploadedFile = {
  file: File;
  id: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function LiteratureReviewPage() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function addFiles(newFiles: File[]) {
    const pdfs = newFiles.filter(f => f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) return;
    setFiles(prev => {
      const combined = [
        ...prev,
        ...pdfs.map(f => ({ file: f, id: `${f.name}-${Date.now()}-${Math.random()}` })),
      ];
      return combined.slice(0, 10);
    });
  }

  function removeFile(id: string) {
    setFiles(prev => prev.filter(f => f.id !== id));
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  }

  const canAnalyze = files.length >= 2;
  const atMax      = files.length >= 10;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <Header title="多篇综述对比" />

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-12 pb-24 sm:pb-12">
        <div className="w-full max-w-3xl space-y-5">

          {/* 标题 */}
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">📚 多篇综述对比</h1>
            <p className="text-sm sm:text-base text-gray-500">
              上传 2–10 篇相关论文，AI 帮你找出研究异同、脉络和空白
            </p>
          </div>

          {/* 上传区（未达到 10 篇上限时显示） */}
          {!atMax && (
            <div
              className="bg-white rounded-2xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors p-8 sm:p-12 text-center cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
            >
              <div className="text-5xl mb-3">📄</div>
              <p className="text-base sm:text-lg font-medium text-gray-700 mb-2">
                {files.length === 0 ? "点击选择 PDF，或拖拽到这里" : "继续添加更多 PDF"}
              </p>
              <p className="text-sm text-gray-400">
                {files.length === 0
                  ? "支持同时选择多个文件，最多上传 10 篇"
                  : `还可再添加 ${10 - files.length} 篇`}
              </p>
              {files.length === 0 && (
                <p className="text-xs text-blue-500 mt-2.5">
                  建议上传同一研究领域的 2–5 篇论文，效果最佳
                </p>
              )}
            </div>
          )}

          {/* 已选文件列表 */}
          {files.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-4 sm:px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                <h2 className="font-semibold text-gray-800 text-sm flex items-center gap-2">
                  已选 {files.length} 篇论文
                  {files.length < 2 && (
                    <span className="text-xs text-amber-500 font-normal">（至少需要 2 篇）</span>
                  )}
                  {atMax && (
                    <span className="text-xs text-gray-400 font-normal">（已达上限 10 篇）</span>
                  )}
                </h2>
                {!atMax && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-blue-500 hover:text-blue-700 transition-colors font-medium"
                  >
                    + 继续添加
                  </button>
                )}
              </div>

              <ul className="divide-y divide-gray-50">
                {files.map((uf, idx) => (
                  <li key={uf.id} className="flex items-center gap-3 px-4 sm:px-5 py-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center">
                      {idx + 1}
                    </span>
                    <span className="text-sm text-gray-700 flex-1 truncate min-w-0">
                      {uf.file.name}
                    </span>
                    <span className="text-xs text-gray-400 shrink-0">{formatBytes(uf.file.size)}</span>
                    <button
                      onClick={() => removeFile(uf.id)}
                      className="shrink-0 w-6 h-6 rounded-full hover:bg-red-50 text-gray-300 hover:text-red-400 transition-colors flex items-center justify-center text-xl leading-none"
                      title="移除"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 开始分析按钮 */}
          {files.length >= 1 && (
            <Button
              disabled={!canAnalyze}
              size="lg"
              className="w-full text-base"
            >
              {canAnalyze
                ? `🔍 开始分析（${files.length} 篇论文）`
                : "请再添加至少 1 篇论文"}
            </Button>
          )}

          {/* 使用建议 */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
            <p className="text-sm font-medium text-blue-700 mb-1.5">💡 使用建议</p>
            <ul className="space-y-1 text-xs text-blue-600">
              <li>• 建议上传同一研究领域的论文，横向对比效果最佳</li>
              <li>• 每次上传 2–5 篇可获得最精准的分析结果</li>
              <li>• AI 会重点提取每篇论文的摘要、引言和结论部分</li>
            </ul>
          </div>

        </div>
      </main>

      {/* 全局隐藏的文件选择框 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        multiple
        className="hidden"
        onChange={handleInputChange}
      />
    </div>
  );
}
