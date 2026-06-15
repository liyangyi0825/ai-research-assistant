"use client";

interface HeaderProps {
  title?: string;
}

export function Header({ title }: HeaderProps) {
  if (!title) return null;

  return (
    <header className="px-6 py-3 flex items-center border-b border-gray-100 bg-white/80 backdrop-blur sticky top-0 z-10">
      <h1 className="text-base font-semibold text-gray-700">{title}</h1>
    </header>
  );
}
