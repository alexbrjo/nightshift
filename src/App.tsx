import { useState } from "react";
import Editor from "./components/Editor";
import ChatPanel from "./components/ChatPanel";
import FileTabs from "./components/FileTabs";
import type { FileTab, ChatMessage } from "./types";

const DEFAULT_CODE = `// Welcome to Nightshift
// Your dark-mode code editor with AI assistance

function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log(fibonacci(10)); // 55`;

export default function App() {
  const [chatOpen, setChatOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Welcome to **Nightshift**. I'm your AI coding assistant. Ask me anything about your code!",
    },
  ]);
  const [fileTabs, setFileTabs] = useState<FileTab[]>([
    { name: "index.js", path: "index.js", content: DEFAULT_CODE, language: "javascript" },
  ]);
  const [activeTab, setActiveTab] = useState(0);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-left">
          <span className="moon-icon">&#9789;</span>
          <span className="app-title">Nightshift</span>
        </div>
        <div className="titlebar-center">
          <button
            className={`panel-toggle ${chatOpen ? "active" : ""}`}
            onClick={() => setChatOpen(!chatOpen)}
            title="Toggle AI Chat"
          >
            &#9881; Chat
          </button>
        </div>
      </header>

      <main className="workspace">
        <div className={`editor-area ${chatOpen ? "with-chat" : ""}`}>
          {fileTabs.length > 0 && (
            <FileTabs
              tabs={fileTabs}
              activeIndex={activeTab}
              onSelect={setActiveTab}
              onClose={(idx) => {
                const newTabs = fileTabs.filter((_, i) => i !== idx);
                setFileTabs(newTabs.length === 0 ? [] : newTabs);
                if (activeTab >= newTabs.length) setActiveTab(Math.max(0, newTabs.length - 1));
              }}
            />
          )}
          <Editor
            code={fileTabs[activeTab]?.content ?? ""}
            language={fileTabs[activeTab]?.language}
            onChange={(code) => {
              const updated = [...fileTabs];
              if (updated[activeTab]) {
                updated[activeTab] = { ...updated[activeTab], content: code, modified: true };
                setFileTabs(updated);
              }
            }}
          />
        </div>

        <ChatPanel
          open={chatOpen}
          messages={messages}
          onSend={(content) => {
            const userMsg: ChatMessage = { role: "user", content };
            setMessages((prev) => [...prev, userMsg]);
          }}
          onAiResponse={(content) => {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant") {
                return [...prev.slice(0, -1), { ...last, content }];
              }
              return [...prev, { role: "assistant", content }];
            });
          }}
        />
      </main>
    </div>
  );
}
