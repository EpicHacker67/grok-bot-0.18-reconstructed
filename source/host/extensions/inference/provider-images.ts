import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type Message = { role: string; content: string | readonly unknown[] };
type Part = { type?: string; text?: string; image?: string };

export function codexMessageInput(messages: readonly Message[]) {
  return messages.map(message => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: typeof message.content === "string" ? message.content : message.content.map(raw => {
      const part = raw as Part;
      if (part.type === "image" && typeof part.image === "string") return { type: "input_image", image_url: part.image, detail: "auto" };
      return { type: message.role === "assistant" ? "output_text" : "input_text", text: part.type === "text" ? part.text ?? "" : JSON.stringify(raw) };
    }),
  }));
}

// Claude's string prompt cannot carry images. Send a structured user message
// with the same role-labelled conversation and actual base64 image blocks.
export function claudeImagePrompt(messages: readonly Message[], instructions: string): AsyncIterable<SDKUserMessage> | null {
  if (!messages.some(message => Array.isArray(message.content) && message.content.some((part: Part) => part.type === "image"))) return null;
  const content: Exclude<SDKUserMessage["message"]["content"], string> = [{ type: "text", text: instructions }];
  for (const message of messages) {
    content.push({ type: "text", text: `${message.role.toUpperCase()}:` });
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const raw of parts) {
      const part = raw as Part;
      if (part.type === "image" && typeof part.image === "string") {
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(part.image);
        if (match == null) throw new Error("This image format is not supported by Claude. Attach a PNG, JPEG, GIF, or WebP image.");
        content.push({ type: "image", source: { type: "base64", media_type: match[1] as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: match[2]! } });
      } else {
        const text = part.type === "text" ? part.text ?? "" : JSON.stringify(raw);
        if (text.length) content.push({ type: "text", text });
      }
    }
  }
  return (async function* () {
    yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content } } satisfies SDKUserMessage;
  })();
}
