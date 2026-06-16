"use client";

import { useState, useRef, useEffect } from "react";
import { PdfTranslationView } from "@/components/PdfTranslationView";
import { Header } from "@/components/Header";

// ── 类型 ───────────────────────────────────────────────────────────────────
interface SavedPage {
  text: string;
  translation: string;
}

interface RestoredSession {
  id: string;
  file_name: string;
  page_count: number;
  pages: SavedPage[];
  created_at: string;
}

// ── 已恢复视图 ─────────────────────────────────────────────────────────────
function RestoredTranslationView({ session, onReset }: { session: RestoredSession; onReset: () => void }) {
  const date = new Date(session.created_at).toLocaleDateString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const hasContent = session.pages.some(p => p.translation?.trim());

  return (
    <div className="min-h-full bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      {/* 顶部工具栏 */}
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-gray-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-gray-700">🌐 全文对照翻译</span>
          <span className="text-xs text-green-600 bg-green-50 px-2.5 py-1 rounded-full border border-green-200">
            ✓ 已恢复上次的翻译结果
          </span>
          <span className="text-xs text-gray-400 hidden sm:block truncate">
            {session.file_name} · {date}
          </span>
          <button
            onClick={onReset}
            className="ml-auto shrink-0 px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            清空重新开始
          </button>
        </div>
      </div>

      {/* 翻译内容 */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-4">
        {hasContent ? (
          <div className="space-y-3">
            {session.pages.map((page, i) =>
              page.translation?.trim() ? (
                <div key={i} className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                  <div className="text-xs font-medium text-blue-500 mb-2">第 {i + 1} 页</div>
                  <div className="text-sm text-gray-800 leading-7 whitespace-pre-wrap">
                    {page.translation}
                  </div>
                </div>
              ) : null
            )}
          </div>
        ) : (
          <div className="text-center text-gray-400 py-16">
            <div className="text-4xl mb-3">📄</div>
            <p>此翻译结果无可显示的内容</p>
            <button
              onClick={onReset}
              className="mt-4 px-4 py-2 text-sm text-blue-500 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
            >
              重新翻译
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

// ── 主页面 ─────────────────────────────────────────────────────────────────
type Stage = "idle" | "error";

export default function TranslatePage() {
  const [stage, setStage]                     = useState<Stage>("idle");
  const [pdfFile, setPdfFile]                 = useState<File | null>(null);
  const [error, setError]                     = useState("");
  const [fileName, setFileName]               = useState("");
  const [restoredData, setRestoredData]       = useState<RestoredSession | null>(null);
  const [sessionNotFound, setSessionNotFound] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 首次挂载：从 URL hash 恢复
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const m = hash.match(/[?&]session=([^&]+)/);
    if (m?.[1]) loadSession(m[1]);
  }, []);

  async function loadSession(id: string) {
    try {
      const res  = await fetch(`/api/translation-sessions?sessionId=${encodeURIComponent(id)}`);
      const data = await res.json() as { session: RestoredSession | null };
      if (data.session) {
        setRestoredData(data.session);
        window.history.replaceState(null, "", `#translate?session=${id}`);
      } else {
        setSessionNotFound(true);
        window.history.replaceState(null, "", "#translate");
      }
    } catch {
      window.history.replaceState(null, "", "#translate");
    }
  }

  function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("请上传 PDF 格式的文件");
      setStage("error");
      return;
    }
    setError("");
    setFileName(file.name);
    setPdfFile(file);
  }

  function handleReset() {
    setPdfFile(null);
    setStage("idle");
    setError("");
    setFileName("");
    setRestoredData(null);
    setSessionNotFound(false);
    window.history.replaceState(null, "", "#translate");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleTranslationComplete(pages: { text: string; translation: string }[]) {
    try {
      const res = await fetch("/api/translation-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: fileName || "未命名.pdf", pages }),
      });
      const data = await res.json() as { id?: string };
      if (data.id) {
        window.history.replaceState(null, "", `#translate?session=${data.id}`);
      }
    } catch {
      // 保存失败不影响翻译结果显示
    }
  }

  // ── 恢复视图 ──
  if (restoredData) {
    return <RestoredTranslationView session={restoredData} onReset={handleReset} />;
  }

  // ── 翻译进行中 ──
  if (pdfFile) {
    return (
      <PdfTranslationView
        file={pdfFile}
        onBack={handleReset}
        onTranslationComplete={handleTranslationComplete}
      />
    );
  }

  // ── 上传页 ──
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

          {/* 上次翻译找不到时的提示 */}
          {sessionNotFound && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
              ℹ️ 上次的翻译结果不存在或已过期，请重新上传 PDF 进行翻译。
            </div>
          )}

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
