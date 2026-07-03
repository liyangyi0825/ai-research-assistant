"use client";

import { diffChars, diffWords } from "diff";

interface PolishDiffViewProps {
  original: string;
  revised: string;
  language: "zh" | "en";
}

export function PolishDiffView({ original, revised, language }: PolishDiffViewProps) {
  const parts = language === "en" ? diffWords(original, revised) : diffChars(original, revised);

  return (
    <div className="whitespace-pre-wrap leading-relaxed text-sm">
      {parts.map((part, i) => {
        if (part.added) {
          return (
            <span key={i} className="bg-green-100 text-green-800 rounded-sm">
              {part.value}
            </span>
          );
        }
        if (part.removed) {
          return (
            <span key={i} className="text-red-500 line-through decoration-red-400">
              {part.value}
            </span>
          );
        }
        return (
          <span key={i} className="text-gray-700">
            {part.value}
          </span>
        );
      })}
    </div>
  );
}
