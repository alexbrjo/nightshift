import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { addAppEventListener } from "../../appEvents";

function isStoredConversationResource(chat: { messages?: unknown[] }) {
  if (!Array.isArray(chat.messages) || chat.messages.length === 0) return false;
  return chat.messages.some((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    if (!("id" in message) || !("role" in message)) return false;
    return !(message.id === "welcome" && message.role === "assistant");
  });
}

export default function ConversationResources({
  openPanelIds,
  onOpenChat,
}: {
  openPanelIds: Set<string>;
  onOpenChat: (chatId?: string, title?: string) => void;
}) {
  const [chats, setChats] = useState<Array<{ id: string; title: string; messages?: unknown[] }>>([]);

  useEffect(() => {
    let cancelled = false;
    let unlistenProject: (() => void) | null = null;
    const loadChats = async () => {
      try {
        const parsed = await invoke<unknown | null>("load_project_conversations");
        if (!cancelled) {
          const resources = Array.isArray(parsed)
            ? (parsed as Array<{ id: string; title: string; messages?: unknown[] }>).filter(isStoredConversationResource)
            : [];
          setChats(resources);
        }
      } catch {
        if (!cancelled) setChats([]);
      }
    };
    const handleConversationsUpdated = () => void loadChats();
    void loadChats();
    const unlistenConversationsUpdated = addAppEventListener("conversationsUpdated", handleConversationsUpdated);
    listen<string>("project-opened", () => {
      if (!cancelled) void loadChats();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenProject = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlistenConversationsUpdated();
      unlistenProject?.();
    };
  }, []);

  return (
    <div className="resource-list">
      <button
        type="button"
        className="resource-create-button"
        onClick={() => onOpenChat()}
        title="Create a new chat"
      >
        Create a new chat
      </button>
      {chats.map((chat) => (
        <button
          key={chat.id}
          type="button"
          className="resource-row"
          onClick={() => onOpenChat(chat.id, chat.title)}
          title={`${chat.title} · ${chat.messages?.length ?? 0} messages`}
        >
          <span className="resource-name">{chat.title}</span>
          {openPanelIds.has(`chat:${encodeURIComponent(chat.id)}`) && <span className="resource-meta">open</span>}
        </button>
      ))}
    </div>
  );
}
