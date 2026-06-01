"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/MarkdownContent";

// ─── 解析 Anthropic SSE 流，逐块 yield 文字 ───────────────────────────────
async function* streamAnthropicSSE(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 每行一个字段，事件之间用空行分隔；这里逐行处理
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 保留最后一段不完整的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          // Anthropic 流式格式：content_block_delta 事件里的 text_delta
          if (
            parsed.type === "content_block_delta" &&
            parsed.delta?.type === "text_delta" &&
            typeof parsed.delta.text === "string"
          ) {
            yield parsed.delta.text;
          }
        } catch {
          // 跳过无法解析的行
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── 解析总结文字，拆成四个部分 ──────────────────────────────────────────────
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

// ─── 三点加载动画组件 ─────────────────────────────────────────────────────────
function DotLoader() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" />
    </span>
  );
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function UploadPage() {
  // ── PDF 提取状态 ──
  const [extractStatus, setExtractStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [uploadStage, setUploadStage] = useState<"uploading" | "extracting">("uploading");
  const [extractedText, setExtractedText] = useState("");
  const [extractError, setExtractError] = useState("");
  const [fileName, setFileName] = useState("");

  // ── AI 总结状态 ──
  // loading = 等待第一个 token；streaming = 文字正在流入；done = 完成
  const [summaryStatus, setSummaryStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [summaryText, setSummaryText] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const summaryStreamId = useRef(0); // 防止旧流覆盖新流

  // ── 对话状态 ──
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatStreamId = useRef(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 自动滚动到对话底部
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ─────────────────────────────────────────────────────────────────────────────
  // PDF 上传与提取（分阶段进度）
  // ─────────────────────────────────────────────────────────────────────────────
  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setExtractStatus("error");
      setExtractError("请上传 PDF 格式的文件");
      return;
    }

    setFileName(file.name);
    setExtractStatus("loading");
    setUploadStage("uploading");
    setExtractError("");
    setSummaryStatus("idle");
    setSummaryText("");
    setMessages([]);

    // 1.5 秒后切换到"正在提取文字"阶段（如果请求还没完成）
    const stageTimer = setTimeout(() => setUploadStage("extracting"), 1500);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: formData });
      clearTimeout(stageTimer);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "解析失败");
      setExtractedText(data.text);
      setExtractStatus("done");
    } catch (err) {
      clearTimeout(stageTimer);
      setExtractStatus("error");
      setExtractError(err instanceof Error ? err.message : "上传失败，请重试");
    }
  }

  function handleReset() {
    setExtractStatus("idle");
    setExtractedText("");
    setExtractError("");
    setFileName("");
    setSummaryStatus("idle");
    setSummaryText("");
    setSummaryError("");
    setMessages([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 生成 AI 总结（流式）
  // ─────────────────────────────────────────────────────────────────────────────
  async function handleSummarize() {
    const myId = ++summaryStreamId.current;
    setSummaryStatus("loading");
    setSummaryError("");
    setSummaryText("");

    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: extractedText }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "总结失败");
      }

      // 逐块读取并累积文字
      let fullText = "";
      for await (const chunk of streamAnthropicSSE(res)) {
        if (summaryStreamId.current !== myId) return; // 用户已重新生成，丢弃旧流
        fullText += chunk;
        setSummaryText(fullText);
      }

      if (summaryStreamId.current !== myId) return;
      setSummaryStatus("done");
    } catch (err) {
      if (summaryStreamId.current !== myId) return;
      setSummaryStatus("error");
      setSummaryError(err instanceof Error ? err.message : "生成失败，请重试");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 发送对话消息（流式）
  // ─────────────────────────────────────────────────────────────────────────────
  async function handleSendMessage() {
    const text = inputText.trim();
    if (!text || chatLoading) return;

    const myId = ++chatStreamId.current;
    const userMessages: Message[] = [...messages, { role: "user", content: text }];

    // 立刻显示用户消息 + 空白占位（用于流入 AI 回复）
    setMessages([...userMessages, { role: "assistant", content: "" }]);
    setInputText("");
    setChatLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperContent: extractedText, messages: userMessages }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "回复失败");
      }

      let reply = "";
      for await (const chunk of streamAnthropicSSE(res)) {
        if (chatStreamId.current !== myId) return;
        reply += chunk;
        setMessages([...userMessages, { role: "assistant", content: reply }]);
      }
    } catch (err) {
      if (chatStreamId.current !== myId) return;
      setMessages([
        ...userMessages,
        {
          role: "assistant",
          content: `❌ ${err instanceof Error ? err.message : "请求失败，请重试"}`,
        },
      ]);
    } finally {
      if (chatStreamId.current === myId) setChatLoading(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 渲染
  // ─────────────────────────────────────────────────────────────────────────────

  // 总结是否正在流入（有文字但还没 done）
  const isSummaryStreaming = summaryStatus === "loading" && summaryText.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      {/* 顶部导航 */}
      <header className="w-full px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between bg-white/70 backdrop-blur border-b border-gray-200">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-2xl">🔬</span>
          <span className="font-bold text-lg text-gray-800">AI 科研助手</span>
        </Link>
        <span className="text-sm text-gray-500">上传论文</span>
      </header>

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 py-6 sm:py-12 pb-24 sm:pb-12">
        <div className="w-full max-w-3xl space-y-4 sm:space-y-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-1">上传 PDF 论文</h1>
            <p className="text-sm sm:text-base text-gray-500">上传后 AI 将自动生成总结，并可与论文对话</p>
          </div>

          {/* ===== 上传区域 ===== */}
          {(extractStatus === "idle" || extractStatus === "error") && (
            <div
              className="bg-white rounded-2xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors p-8 sm:p-12 text-center cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
              onDragOver={(e) => e.preventDefault()}
            >
              <div className="text-5xl mb-3 sm:mb-4">📄</div>
              <p className="text-base sm:text-lg font-medium text-gray-700 mb-2">点击选择文件，或拖拽 PDF 到这里</p>
              <p className="text-sm text-gray-400">仅支持 PDF 格式，最大 20MB</p>
              {extractStatus === "error" && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                  ❌ {extractError}
                </div>
              )}
              <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            </div>
          )}

          {/* ===== PDF 上传中（分阶段进度）===== */}
          {extractStatus === "loading" && (
            <div className="bg-white rounded-2xl p-8 sm:p-12 text-center shadow-sm">
              <div className="text-5xl mb-5">
                {uploadStage === "uploading" ? "📤" : "📄"}
              </div>

              {/* 进度步骤指示器 */}
              <div className="flex items-center justify-center gap-2 mb-4">
                {/* 步骤1 */}
                <div className={`flex items-center gap-1.5 text-sm font-medium ${
                  uploadStage === "uploading" ? "text-blue-600" : "text-green-500"
                }`}>
                  {uploadStage === "uploading" ? <DotLoader /> : <span>✓</span>}
                  <span>正在上传</span>
                </div>
                <span className="text-gray-300">→</span>
                {/* 步骤2 */}
                <div className={`flex items-center gap-1.5 text-sm font-medium ${
                  uploadStage === "extracting" ? "text-blue-600" : "text-gray-300"
                }`}>
                  {uploadStage === "extracting" && <DotLoader />}
                  <span>提取文字</span>
                </div>
              </div>

              <p className="text-sm text-gray-400 truncate px-4">{fileName}</p>
            </div>
          )}

          {/* ===== PDF 解析完成 ===== */}
          {extractStatus === "done" && (
            <>
              {/* 文件信息栏 */}
              <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm flex items-start sm:items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-800 truncate">✅ {fileName}</p>
                  <p className="text-sm text-gray-400 mt-0.5">已提取 {extractedText.length.toLocaleString()} 个字符</p>
                </div>
                <Button variant="outline" size="sm" onClick={handleReset} className="shrink-0">重新上传</Button>
              </div>

              {/* ===== AI 总结区域 ===== */}

              {/* 等待点击 */}
              {summaryStatus === "idle" && (
                <div className="bg-white rounded-2xl p-6 sm:p-8 text-center shadow-sm border border-blue-100">
                  <div className="text-4xl mb-3">✨</div>
                  <h2 className="text-base sm:text-lg font-semibold text-gray-800 mb-2">让 AI 为你总结这篇论文</h2>
                  <p className="text-sm text-gray-500 mb-5">生成研究问题、方法、结论、创新点四个部分</p>
                  <Button size="lg" className="w-full sm:w-auto" onClick={handleSummarize}>生成 AI 总结</Button>
                </div>
              )}

              {/* 等待第一个 token */}
              {summaryStatus === "loading" && !summaryText && (
                <div className="bg-white rounded-2xl p-8 sm:p-10 text-center shadow-sm">
                  <div className="flex justify-center mb-5">
                    <DotLoader />
                  </div>
                  <p className="text-base sm:text-lg font-medium text-gray-700">AI 正在读取论文...</p>
                  <p className="text-sm text-gray-400 mt-2">通常需要几秒钟</p>
                </div>
              )}

              {/* 流式文字进入中 */}
              {isSummaryStreaming && (
                <div className="space-y-3 sm:space-y-4">
                  <div className="flex items-center gap-2">
                    <DotLoader />
                    <h2 className="text-lg sm:text-xl font-bold text-gray-700">AI 正在生成总结...</h2>
                  </div>
                  <div className="bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-blue-50">
                    <MarkdownContent content={summaryText} className="text-sm" />
                    {/* 光标闪烁效果 */}
                    <span className="inline-block w-0.5 h-4 bg-blue-400 ml-0.5 align-middle animate-pulse" />
                  </div>
                </div>
              )}

              {/* 生成失败 */}
              {summaryStatus === "error" && (
                <div className="bg-white rounded-2xl p-5 sm:p-6 shadow-sm">
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm mb-4">❌ {summaryError}</div>
                  <Button className="w-full sm:w-auto" onClick={handleSummarize}>重试</Button>
                </div>
              )}

              {/* 生成完毕，拆分展示 */}
              {summaryStatus === "done" && (
                <div className="space-y-3 sm:space-y-4">
                  <h2 className="text-lg sm:text-xl font-bold text-gray-800">📋 AI 论文总结</h2>
                  {parseSummary(summaryText).map(({ key, icon, content }) => (
                    <div key={key} className="bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-gray-100">
                      <h3 className="font-semibold text-gray-800 mb-2 sm:mb-3">{icon} {key}</h3>
                      <MarkdownContent content={content} className="text-sm" />
                    </div>
                  ))}
                  <Button variant="outline" className="w-full" onClick={handleSummarize}>重新生成总结</Button>
                </div>
              )}

              {/* ===== 论文对话区域（总结完成后显示）===== */}
              {summaryStatus === "done" && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-100 bg-gray-50">
                    <h2 className="font-semibold text-gray-800">💬 与论文对话</h2>
                    <p className="text-xs sm:text-sm text-gray-400 mt-0.5">针对这篇论文的内容提问，AI 将基于原文回答</p>
                  </div>

                  {/* 消息列表 */}
                  <div className="p-3 sm:p-4 space-y-3 sm:space-y-4 max-h-64 sm:max-h-96 overflow-y-auto">
                    {messages.length === 0 && (
                      <div className="text-center py-6 sm:py-8 text-gray-400 text-sm">
                        <p className="text-2xl mb-2">💡</p>
                        <p>可以问任何关于这篇论文的问题</p>
                        <p className="mt-1 text-xs">例如："这篇论文用了什么数据集？"</p>
                      </div>
                    )}
                    {messages.map((msg, i) => {
                      const isLastMsg = i === messages.length - 1;
                      const isStreamingThis = isLastMsg && msg.role === "assistant" && chatLoading;
                      return (
                        <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                          <div className={`max-w-[85%] rounded-2xl px-3 sm:px-4 py-2.5 sm:py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                            msg.role === "user"
                              ? "bg-blue-600 text-white rounded-br-sm"
                              : "bg-gray-100 text-gray-800 rounded-bl-sm"
                          }`}>
                            {/* 空内容时显示三点等待动画 */}
                            {!msg.content && isStreamingThis
                              ? <span className="flex gap-1 py-0.5"><span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]" /><span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]" /><span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" /></span>
                              : msg.content
                            }
                            {/* 流式光标 */}
                            {isStreamingThis && msg.content && (
                              <span className="inline-block w-0.5 h-3.5 bg-gray-500 ml-0.5 align-middle animate-pulse" />
                            )}
                          </div>
                        </div>
                      );
                    })}
                    <div ref={chatBottomRef} />
                  </div>

                  {/* 输入框 */}
                  <div className="p-3 sm:p-4 border-t border-gray-100 flex gap-2 sm:gap-3">
                    <input
                      type="text"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
                      placeholder="输入问题，按回车发送..."
                      disabled={chatLoading}
                      className="flex-1 min-w-0 rounded-xl border border-gray-200 px-3 sm:px-4 py-2.5 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                    />
                    <Button onClick={handleSendMessage} disabled={chatLoading || !inputText.trim()} className="shrink-0">
                      发送
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
