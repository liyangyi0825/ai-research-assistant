"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * 渲染 AI 返回的 Markdown 格式文本
 * 支持加粗、列表等基础格式
 */
export function MarkdownContent({ content, className = "" }: MarkdownContentProps) {
  return (
    <div className={className}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // 加粗：深色 + font-bold
        strong: ({ children }) => (
          <strong className="font-bold text-gray-900">{children}</strong>
        ),
        // 无序列表：有缩进和间距
        ul: ({ children }) => (
          <ul className="mt-2 space-y-1.5 pl-1">{children}</ul>
        ),
        // 列表项：左侧圆点
        li: ({ children }) => (
          <li className="flex gap-2 text-gray-700">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
            <span>{children}</span>
          </li>
        ),
        // 段落：段落间距
        p: ({ children }) => (
          <p className="leading-relaxed text-gray-700">{children}</p>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
    </div>
  );
}
