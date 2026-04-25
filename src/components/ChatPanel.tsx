import { useState, useRef, useEffect } from "react";

interface ChatPanelProps {
  open: boolean;
  messages: Array<{ role: string; content: string }>;
  onSend: (content: string) => void;
  onAiResponse: (content: string) => void;
}

export default function ChatPanel({ open, messages, onSend, onAiResponse }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    onSend(userMessage);
    setLoading(true);

    try {
      const apiBase = "http://localhost:1234/v1";

      const chatMessages = messages.map((m) => ({
        role: m.role,
        content: m.content.replace(/\*\*/g, ""),
      }));
      chatMessages.push({ role: "user", content: userMessage });

      const response = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "unsloth/qwen3.6-35b-a3b",
          messages: chatMessages,
          stream: true,
          temperature: 0.7,
          max_tokens: 2048,
        }),
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) {
        onAiResponse("Error: No stream available");
        setLoading(false);
        return;
      }

      let fullContent = "";
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));

        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              onAiResponse(fullContent);
            }
          } catch {
            // Skip non-JSON lines
          }
        }
      }

      if (!fullContent) {
        onAiResponse("(No response from model)");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      onAiResponse(`Error connecting to AI server: ${message}\n\nMake sure a local OpenAI-compatible server is running at http://localhost:1234`);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const renderContent = (content: string) => {
    return content.split(/(\*\*.*?\*\*)/g).map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      const codeMatch = part.match(/^`(.+?)`$/s);
      if (codeMatch) {
        return (
          <code key={i} className="inline-code">
            {codeMatch[1]}
          </code>
        );
      }
      const blockCode = part.match(/^```(\w*)\n([\s\S]*?)```$/);
      if (blockCode) {
        return (
          <pre key={i} className="chat-code-block">
            <code>{blockCode[2]}</code>
          </pre>
        );
      }
      return part;
    });
  };

  if (!open) return null;

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">&#9789; AI Assistant</span>
      </div>

      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            <div className="chat-bubble">
              <div className="chat-sender">{msg.role === "user" ? "You" : "Nightshift AI"}</div>
              <div className="chat-content">{renderContent(msg.content)}</div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="chat-message assistant">
            <div className="chat-bubble typing-indicator">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      <form className="chat-input-area" onSubmit={handleSubmit}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your code..."
          rows={1}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          &#9658;
        </button>
      </form>
    </div>
  );
}
