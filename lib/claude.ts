// Claude API 调用封装
// 所有对 Anthropic Claude 的请求都通过这个文件发出
// TODO: 第三步（生成论文总结）和第四步（论文问答）时填充这里的函数

export async function summarizePaper(paperContent: string): Promise<string> {
  // 调用 /api/summarize 后端接口
  const res = await fetch("/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: paperContent }),
  });

  if (!res.ok) {
    throw new Error("总结生成失败，请稍后重试");
  }

  const data = await res.json();
  return data.summary;
}

export async function chatWithPaper(
  paperContent: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>
): Promise<string> {
  // 调用 /api/chat 后端接口
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: paperContent, messages }),
  });

  if (!res.ok) {
    throw new Error("对话失败，请稍后重试");
  }

  const data = await res.json();
  return data.reply;
}
