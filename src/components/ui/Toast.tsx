import { useState, useCallback, useEffect, createContext, useContext, useRef } from "react";

export type ToastType = "error" | "success" | "info";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType>({
  showToast: () => {},
});

export const useToast = () => useContext(ToastContext);

let idCounter = 0;
function generateId() {
  return `toast-${++idCounter}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: ToastType = "error") => {
    const id = generateId();
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-container">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => removeToast(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const timerRef = useRef<number>(0);

  useEffect(() => {
    timerRef.current = window.setTimeout(onDismiss, 4000);
    return () => window.clearTimeout(timerRef.current);
  }, [onDismiss]);

  const icon = toast.type === "error" ? "\u2715" : toast.type === "success" ? "\u2713" : "\u25CF";

  return (
    <div className={`toast toast-${toast.type}`} onClick={onDismiss}>
      <span className="toast-icon">{icon}</span>
      <span className="toast-message">{toast.message}</span>
    </div>
  );
}
