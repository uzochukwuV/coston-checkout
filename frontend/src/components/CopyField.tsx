import { useState } from "react";

interface CopyFieldProps {
  label: string;
  value: string;
  /** Whether to truncate the displayed value (default: true). */
  truncate?: boolean;
  /** Font size in px (default 14). */
  mono?: boolean;
}

export function CopyField({ label, value, truncate = true, mono = true }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const displayValue = truncate && value.length > 24
    ? `${value.slice(0, 12)}…${value.slice(-8)}`
    : value;

  return (
    <div>
      <div className="label">{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <code
          className={mono ? "mono" : ""}
          style={{
            fontSize: 14,
            color: "var(--text)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={value}
        >
          {displayValue}
        </code>
        <button className="copy-btn" onClick={copy} type="button">
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
