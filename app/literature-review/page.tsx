"use client";

import { useState, useRef, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { MarkdownContent } from "@/components/MarkdownContent";
import { toast } from "sonner";

type UploadedFile = { file: File; id: string };
type Stage = "upload" | "extracting" | "analyzing" | "done" | "error";
type ExtractStatus = "pending" | "loading" | "done" | "error";
interface Section { title: string; content: string }

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SECTION_ICONS: Record<string, string> = {
  "研究概览": "📊",
  "研究脉络": "🕐",
  "方法对比": "⚖️",
  "结论异同": "🔄",
  "研究空白": "🎯",
  "综述初稿": "✍️",
};

const DEFAULT_EXPANDED: Record<string, boolean> = {
  "研究概览": true,
  "研究空白": true,
};

function parseSections(text: string): Section[] {
  if (!text) return [];
  const parts = text.split("\n## ");
  return parts
    .map((part, i) => {
      const raw = i === 0 ? part.replace(/^## /, "") : part;
      const nl = raw.indexOf("\n");
      return {
        title: (nl === -1 ? raw : raw.slice(0, nl)).trim(),
        content: nl === -1 ? "" : raw.slice(nl + 1).trim(),
      };
    })
    .filter(s => s.title);
}

export default function LiteratureReviewPage() {
  // Upload state
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Processing state
  const [stage, setStage] = useState<Stage>("upload");
  const [extractStatus, setExtractStatus] = useState<Record<number, ExtractStatus>>({});
  const [extractedTexts, setExtractedTexts] = useState<string[]>([]);
  const [totalChars, setTotalChars] = useState(0);
  const [analysisText, setAnalysisText] = useState("");
  const [analysisError, setAnalysisError] = useState("");

  // Result interaction state
  const [expanded, setExpanded] = useState<Record<string, boolean>>(DEFAULT_EXPANDED);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [copyDone, setCopyDone] = useState(false);

  // 刷新恢复
  const [showRestoreBanner, setShowRestoreBanner] = useState(false);
  const [restoredPaperNames, setRestoredPaperNames] = useState<string[]>([]);
  const STORAGE_KEY = "iyanhub_review";
  const SEVEN_DAYS  = 7 * 24 * 60 * 60 * 1000;

  // 用 ref 持有最新保存函数，避免 setInterval 闭包陈旧
  const saveLatestRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveLatestRef.current = () => {
      const paperNames = files.length > 0 ? files.map(f => f.file.name) : restoredPaperNames;
      if (!paperNames.length || !analysisText) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          paperNames, extractedTexts, analysisText, timestamp: Date.now(),
        }));
      } catch { /* 静默 */ }
    };
  }, [files, restoredPaperNames, extractedTexts, analysisText]);

  // 分析中每 2 秒保存一次
  useEffect(() => {
    if (stage !== "analyzing") return;
    const timer = setInterval(() => saveLatestRef.current(), 2000);
    return () => clearInterval(timer);
  }, [stage]);

  // 分析完成后立即保存完整结果
  useEffect(() => {
    if (stage === "done") saveLatestRef.current();
  }, [stage]);

  // 页面加载时恢复
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as {
        paperNames: string[];
        extractedTexts: string[];
        analysisText: string;
        timestamp: number;
      };
      if (Date.now() - data.timestamp > SEVEN_DAYS) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      if (!data.analysisText || !data.paperNames?.length) return;
      const texts = data.extractedTexts ?? [];
      const initStatus: Record<number, ExtractStatus> = {};
      data.paperNames.forEach((_, i) => { initStatus[i] = "done"; });
      setRestoredPaperNames(data.paperNames);
      setExtractedTexts(texts);
      setTotalChars(texts.reduce((s, t) => s + t.length, 0));
      setExtractStatus(initStatus);
      setAnalysisText(data.analysisText);
      setStage("done");
      setExpanded(DEFAULT_EXPANDED);
      setShowRestoreBanner(true);
    } catch { /* 静默 */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // File management
  function addFiles(newFiles: File[]) {
    const pdfs = newFiles.filter(f => f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) return;
    setFiles(prev =>
      [...prev, ...pdfs.map(f => ({ file: f, id: `${f.name}-${Date.now()}-${Math.random()}` }))].slice(0, 10)
    );
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

  // Main analysis flow
  async function handleAnalyze() {
    setStage("extracting");
    setAnalysisText("");
    setAnalysisError("");
    setSaveStatus("idle");
    setCopyDone(false);
    setExpanded(DEFAULT_EXPANDED);

    const initStatus: Record<number, ExtractStatus> = {};
    files.forEach((_, i) => { initStatus[i] = "pending"; });
    setExtractStatus(initStatus);

    // Extract all PDFs sequentially
    const texts: string[] = [];
    for (let i = 0; i < files.length; i++) {
      setExtractStatus(prev => ({ ...prev, [i]: "loading" }));
      try {
        const formData = new FormData();
        formData.append("file", files[i].file);
        const res = await fetch("/api/extract", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error((data as { error?: string }).error ?? "提取失败");
        texts.push(((data as { text?: string }).text ?? "").slice(0, 8000));
        setExtractStatus(prev => ({ ...prev, [i]: "done" }));
      } catch {
        setExtractStatus(prev => ({ ...prev, [i]: "error" }));
        texts.push(""); // keep indices aligned
      }
      setExtractedTexts([...texts]);
    }

    const total = texts.reduce((sum, t) => sum + t.length, 0);
    setTotalChars(total);

    // Call AI analysis
    setStage("analyzing");
    try {
      const paperNames = files.map(f => f.file.name.replace(/\.pdf$/i, ""));
      const res = await fetch("/api/literature-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          papers: texts.map((content, i) => ({ name: paperNames[i], content })),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "分析失败，请重试");
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
              setAnalysisText(fullText);
            }
          } catch { /* skip malformed SSE */ }
        }
      }

      setStage("done");
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "分析失败，请重试");
      setStage("error");
    }
  }

  async function handleSaveNote() {
    if (saveStatus === "saving" || saveStatus === "saved") return;
    setSaveStatus("saving");
    const title = `${files.length} 篇论文综述对比`;
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept: title,
          origin_summary: analysisText,
          source_type: "literature_review",
          source_id: null,
          source_title: title,
        }),
      });
      if (!res.ok) throw new Error();
      setSaveStatus("saved");
      toast.success("已保存到研究笔记");
    } catch {
      setSaveStatus("error");
      toast.error("保存失败，请重试");
    }
  }

  function handleCopy(content: string) {
    navigator.clipboard.writeText(content).catch(() => {});
    setCopyDone(true);
    setTimeout(() => setCopyDone(false), 2000);
  }

  function handleReset() {
    localStorage.removeItem(STORAGE_KEY);
    setFiles([]);
    setStage("upload");
    setExtractStatus({});
    setExtractedTexts([]);
    setTotalChars(0);
    setAnalysisText("");
    setAnalysisError("");
    setSaveStatus("idle");
    setCopyDone(false);
    setExpanded(DEFAULT_EXPANDED);
    setRestoredPaperNames([]);
    setShowRestoreBanner(false);
  }

  const sections = useMemo(() => parseSections(analysisText), [analysisText]);
  const canAnalyze = files.length >= 2;
  const atMax = files.length >= 10;
  const displayPaperNames = useMemo(
    () => files.length > 0 ? files.map(f => f.file.name) : restoredPaperNames,
    [files, restoredPaperNames]
  );

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

          {/* 恢复 Banner */}
          {showRestoreBanner && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
              <span className="text-sm text-blue-700">✨ 已恢复上次的综述内容</span>
              <button
                onClick={handleReset}
                className="text-xs text-blue-500 hover:text-blue-700 whitespace-nowrap transition-colors"
              >
                清空重新开始
              </button>
            </div>
          )}

          {/* ── 上传阶段 ── */}
          {stage === "upload" && (
            <>
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
                        <span className="text-sm text-gray-700 flex-1 truncate min-w-0">{uf.file.name}</span>
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

              {files.length >= 1 && (
                <Button disabled={!canAnalyze} size="lg" className="w-full text-base" onClick={handleAnalyze}>
                  {canAnalyze
                    ? `🔍 开始分析（${files.length} 篇论文）`
                    : "请再添加至少 1 篇论文"}
                </Button>
              )}

              <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                <p className="text-sm font-medium text-blue-700 mb-1.5">💡 使用建议</p>
                <ul className="space-y-1 text-xs text-blue-600">
                  <li>• 建议上传同一研究领域的论文，横向对比效果最佳</li>
                  <li>• 每次上传 2–5 篇可获得最精准的分析结果</li>
                  <li>• AI 会提取每篇论文前 8000 字进行分析</li>
                </ul>
              </div>
            </>
          )}

          {/* ── 提取 & 分析进度阶段 ── */}
          {stage !== "upload" && (
            <>
              {/* 文字提取进度卡 */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="px-4 sm:px-5 py-3 border-b border-gray-100">
                  <h2 className="font-semibold text-gray-800 text-sm">
                    {stage === "extracting" ? "📤 正在提取文字…" : "✅ 文字提取完成"}
                  </h2>
                </div>
                <ul className="divide-y divide-gray-50">
                  {displayPaperNames.map((name, idx) => {
                    const st = extractStatus[idx] ?? "pending";
                    return (
                      <li key={`${name}-${idx}`} className="flex items-center gap-3 px-4 sm:px-5 py-2.5">
                        <span className="shrink-0 w-5 text-center text-sm">
                          {st === "loading" ? (
                            <span className="inline-block w-3.5 h-3.5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                          ) : st === "done" ? "✅" : st === "error" ? "❌" : "⏳"}
                        </span>
                        <span className="text-sm text-gray-600 truncate flex-1">{name}</span>
                        {st === "done" && extractedTexts[idx] !== undefined && (
                          <span className="text-xs text-gray-400 shrink-0">
                            {extractedTexts[idx].length.toLocaleString()} 字
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {totalChars > 40000 && (
                  <div className="px-4 py-3 bg-amber-50 border-t border-amber-100 text-xs text-amber-700">
                    ⚠️ 内容较多（{(totalChars / 10000).toFixed(1)} 万字），每篇已截取前 8000 字进行分析。建议每次不超过 5 篇以获得最佳效果。
                  </div>
                )}
              </div>

              {/* AI 分析等待中 */}
              {(stage === "analyzing" || stage === "done") && sections.length === 0 && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
                  <div className="flex justify-center mb-3 gap-1">
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" />
                  </div>
                  <p className="text-sm text-gray-500">AI 正在深度分析 {files.length} 篇论文…</p>
                  <p className="text-xs text-gray-400 mt-1">通常需要 20–60 秒</p>
                </div>
              )}

              {/* 错误提示 */}
              {stage === "error" && (
                <div className="bg-white rounded-2xl p-5 shadow-sm border border-red-100">
                  <p className="text-red-500 text-sm mb-3">❌ {analysisError}</p>
                  <Button variant="outline" size="sm" onClick={handleReset}>重新上传</Button>
                </div>
              )}

              {/* 分析结果：折叠卡片区 */}
              {sections.length > 0 && (
                <div className="space-y-3">
                  {sections.map(sec => {
                    const icon = SECTION_ICONS[sec.title] ?? "📌";
                    const isExpanded = expanded[sec.title] ?? false;
                    const isDraft = sec.title === "综述初稿";
                    const isLast = sections[sections.length - 1]?.title === sec.title && stage === "analyzing";

                    return (
                      <div key={sec.title} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                        {/* 标题栏 */}
                        <button
                          className="w-full flex items-center justify-between px-4 sm:px-5 py-3 hover:bg-gray-50 transition-colors text-left"
                          onClick={() => setExpanded(prev => ({ ...prev, [sec.title]: !prev[sec.title] }))}
                        >
                          <span className="font-semibold text-gray-800 text-sm flex items-center gap-2">
                            <span>{icon}</span>
                            <span>{sec.title}</span>
                            {isLast && !sec.content && (
                              <span className="text-xs font-normal text-gray-400 animate-pulse">生成中…</span>
                            )}
                          </span>
                          <span className="text-gray-400 text-xs shrink-0 ml-2">{isExpanded ? "▲" : "▼"}</span>
                        </button>

                        {/* 内容区 */}
                        {isExpanded && sec.content && (
                          <div className="px-4 sm:px-5 pb-4 border-t border-gray-50 pt-3">
                            <div className="overflow-x-auto">
                              <MarkdownContent content={sec.content} className="text-sm" />
                            </div>
                            {isDraft && (
                              <div className="mt-3 flex justify-end">
                                <button
                                  onClick={() => handleCopy(sec.content)}
                                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-500 hover:text-gray-700 transition-colors"
                                >
                                  {copyDone ? "✓ 已复制" : "📋 复制全文"}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* 完成后操作区 */}
                  {stage === "done" && (
                    <div className="flex flex-col sm:flex-row gap-3 pt-1">
                      <Button
                        onClick={handleSaveNote}
                        disabled={saveStatus === "saving" || saveStatus === "saved"}
                        className="flex-1"
                      >
                        {saveStatus === "saving" ? "保存中…" :
                         saveStatus === "saved"  ? "✓ 已保存到研究笔记" :
                         saveStatus === "error"  ? "❌ 保存失败，点击重试" :
                         "💾 保存到研究笔记"}
                      </Button>
                      <Button variant="outline" className="flex-1" onClick={handleReset}>
                        分析其他论文
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

        </div>
      </main>

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
