"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * 渲染 AI 返回的 Markdown 格式文本
 * 支持加粗、列表等基础格式，以及 KaTeX 数学公式（$...$、$$...$$）
 */
export function MarkdownContent({ content, className = "" }: MarkdownContentProps) {
  return (
    <div className={className}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
      components={{
        // 标题
        h1: ({ children }) => (
          <h1 className="text-base font-bold text-gray-900 mt-3 mb-1">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-sm font-bold text-gray-900 mt-3 mb-1">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-sm font-semibold text-gray-800 mt-2 mb-0.5">{children}</h3>
        ),
        // 加粗：深色 + font-bold
        strong: ({ children }) => (
          <strong className="font-bold text-gray-900">{children}</strong>
        ),
        // 无序列表：有缩进和间距
        ul: ({ children }) => (
          <ul className="mt-2 space-y-1.5 pl-1">{children}</ul>
        ),
        // 有序列表
        ol: ({ children }) => (
          <ol className="mt-2 space-y-1.5 pl-1 list-decimal list-inside">{children}</ol>
        ),
        // 列表项：左侧圆点（无序）/ 数字（有序）由父元素决定
        li: ({ children }) => (
          <li className="flex gap-2 text-gray-700">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
            <span>{children}</span>
          </li>
        ),
        // 段落：段落间距
        p: ({ children }) => (
          <p className="leading-relaxed text-gray-700 mt-1 first:mt-0">{children}</p>
        ),
        // 行内代码
        code: ({ children }) => (
          <code className="bg-gray-200 text-gray-800 px-1 py-0.5 rounded text-xs font-mono">{children}</code>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
    </div>
  );
}
