import { useEffect } from "react";

interface DialogProps {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}

export default function Dialog({ title, isOpen, onClose, width = 500, children }: DialogProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div 
        className="dialog-box" 
        onClick={(e) => e.stopPropagation()}
        style={{ width: `${width}px` }}
      >
        <div className="dialog-title">{title}</div>
        {children}
      </div>
    </div>
  );
}
