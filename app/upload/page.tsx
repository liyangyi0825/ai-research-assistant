"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/MarkdownContent";

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

interface Message {
  role: "user" | "assistant";
  content: string;
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

  // 对话状态
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 自动滚动到对话最底部
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
    setMessages([]);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "解析失败");
      setExtractedText(data.text);
      setExtractStatus("done");
    } catch (err) {
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

  // ——— 生成 AI 总结 ———
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

  // ——— 发送对话消息 ———
  async function handleSendMessage() {
    const text = inputText.trim();
    if (!text || chatLoading) return;

    const newMessages: Message[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setInputText("");
    setChatLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paperContent: extractedText,
          messages: newMessages,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "回复失败");
      setMessages([...newMessages, { role: "assistant", content: data.reply }]);
    } catch (err) {
      setMessages([
        ...newMessages,
        {
          role: "assistant",
          content: `❌ ${err instanceof Error ? err.message : "请求失败，请重试"}`,
        },
      ]);
    } finally {
      setChatLoading(false);
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
            <p className="text-gray-500">上传后 AI 将自动生成总结，并可与论文对话</p>
          </div>

          {/* ===== 上传区域 ===== */}
          {(extractStatus === "idle" || extractStatus === "error") && (
            <div
              className="bg-white rounded-2xl border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors p-12 text-center cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
              onDragOver={(e) => e.preventDefault()}
            >
              <div className="text-5xl mb-4">📄</div>
              <p className="text-lg font-medium text-gray-700 mb-2">点击选择文件，或将 PDF 拖拽到这里</p>
              <p className="text-sm text-gray-400">仅支持 PDF 格式，最大 20MB</p>
              {extractStatus === "error" && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                  ❌ {extractError}
                </div>
              )}
              <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            </div>
          )}

          {/* ===== PDF 解析中 ===== */}
          {extractStatus === "loading" && (
            <div className="bg-white rounded-2xl p-12 text-center shadow-sm">
              <div className="text-5xl mb-4 animate-bounce">⏳</div>
              <p className="text-lg font-medium text-gray-700">正在解析 <span className="text-blue-600">{fileName}</span> ...</p>
            </div>
          )}

          {/* ===== PDF 解析完成 ===== */}
          {extractStatus === "done" && (
            <>
              {/* 文件信息栏 */}
              <div className="bg-white rounded-2xl p-5 shadow-sm flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-800">✅ {fileName}</p>
                  <p className="text-sm text-gray-400 mt-0.5">已提取 {extractedText.length.toLocaleString()} 个字符</p>
                </div>
                <Button variant="outline" size="sm" onClick={handleReset}>重新上传</Button>
              </div>

              {/* ===== AI 总结区域 ===== */}
              {summaryStatus === "idle" && (
                <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-blue-100">
                  <div className="text-4xl mb-3">✨</div>
                  <h2 className="text-lg font-semibold text-gray-800 mb-2">让 AI 为你总结这篇论文</h2>
                  <p className="text-sm text-gray-500 mb-5">生成研究问题、方法、结论、创新点四个部分</p>
                  <Button size="lg" onClick={handleSummarize}>生成 AI 总结</Button>
                </div>
              )}

              {summaryStatus === "loading" && (
                <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
                  <div className="text-5xl mb-4 animate-spin">⚙️</div>
                  <p className="text-lg font-medium text-gray-700">AI 正在阅读论文并生成总结...</p>
                  <p className="text-sm text-gray-400 mt-2">通常需要 10～30 秒</p>
                </div>
              )}

              {summaryStatus === "error" && (
                <div className="bg-white rounded-2xl p-6 shadow-sm">
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm mb-4">❌ {summaryError}</div>
                  <Button onClick={handleSummarize}>重试</Button>
                </div>
              )}

              {summaryStatus === "done" && (
                <div className="space-y-4">
                  <h2 className="text-xl font-bold text-gray-800">📋 AI 论文总结</h2>
                  {parseSummary(summaryText).map(({ key, icon, content }) => (
                    <div key={key} className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
                      <h3 className="font-semibold text-gray-800 mb-3">{icon} {key}</h3>
                      <MarkdownContent content={content} className="text-sm" />
                    </div>
                  ))}
                  <Button variant="outline" className="w-full" onClick={handleSummarize}>重新生成总结</Button>
                </div>
              )}

              {/* ===== 论文对话区域（总结完成后显示）===== */}
              {summaryStatus === "done" && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
                    <h2 className="font-semibold text-gray-800">💬 与论文对话</h2>
                    <p className="text-sm text-gray-400 mt-0.5">针对这篇论文的内容提问，AI 将基于原文回答</p>
                  </div>

                  {/* 消息列表 */}
                  <div className="p-4 space-y-4 max-h-96 overflow-y-auto">
                    {messages.length === 0 && (
                      <div className="text-center py-8 text-gray-400 text-sm">
                        <p className="text-2xl mb-2">💡</p>
                        <p>可以问任何关于这篇论文的问题</p>
                        <p className="mt-1 text-xs">例如："这篇论文用了什么数据集？" "作者的主要贡献是什么？"</p>
                      </div>
                    )}
                    {messages.map((msg, i) => (
                      <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                          msg.role === "user"
                            ? "bg-blue-600 text-white rounded-br-sm"
                            : "bg-gray-100 text-gray-800 rounded-bl-sm"
                        }`}>
                          {msg.content}
                        </div>
                      </div>
                    ))}
                    {chatLoading && (
                      <div className="flex justify-start">
                        <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-gray-500">
                          AI 正在思考...
                        </div>
                      </div>
                    )}
                    <div ref={chatBottomRef} />
                  </div>

                  {/* 输入框 */}
                  <div className="p-4 border-t border-gray-100 flex gap-3">
                    <input
                      type="text"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
                      placeholder="输入你的问题，按回车发送..."
                      disabled={chatLoading}
                      className="flex-1 rounded-xl border border-gray-200 px-4 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
                    />
                    <Button onClick={handleSendMessage} disabled={chatLoading || !inputText.trim()}>
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
