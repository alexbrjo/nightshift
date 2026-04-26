import { useState, useEffect, useRef } from "react";

export default function InputDialog({
  title,
  label,
  defaultValue,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = () => {
    if (value.trim()) onSubmit(value.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <label className="dialog-label">{label}</label>
        <input
          ref={inputRef}
          className="dialog-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="dialog-btn primary" onClick={handleSubmit}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
