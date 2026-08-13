/**
 * Countdown timer — shows time remaining until an order expires.
 * Calls onComplete when the timer reaches zero.
 */
import { useEffect, useState } from "react";

export function CountdownTimer({
  expiresAt,
  onComplete,
}: {
  expiresAt: number;
  onComplete?: () => void;
}) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Math.floor(Date.now() / 1000)));

  useEffect(() => {
    const interval = setInterval(() => {
      const r = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
      setRemaining(r);
      if (r === 0) {
        clearInterval(interval);
        onComplete?.();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt, onComplete]);

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const isUrgent = remaining < 60;

  return (
    <span
      style={{
        fontVariantNumeric: "tabular-nums",
        color: isUrgent ? "var(--danger)" : "var(--text-dim)",
        fontWeight: isUrgent ? 700 : 500,
      }}
      className="mono"
    >
      {minutes}:{seconds.toString().padStart(2, "0")}
    </span>
  );
}
