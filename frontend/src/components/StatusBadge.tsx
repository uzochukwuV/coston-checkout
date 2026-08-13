import type { OrderStatus } from "../types";
import { statusStepIndex, FLOW_STEPS } from "../types";

export function StatusBadge({ status }: { status: OrderStatus }) {
  const cls = badgeClass(status);
  return <span className={`badge ${cls}`}>{status.replace(/_/g, " ")}</span>;
}

export function StatusFlow({ status }: { status: OrderStatus }) {
  const currentStep = statusStepIndex(status);
  const isError = currentStep < 0;
  if (isError) {
    return <StatusBadge status={status} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 0, marginBottom: 8 }}>
        {FLOW_STEPS.map((step, i) => {
          const done = i < currentStep;
          const active = i === currentStep;
          return (
            <div
              key={step.status}
              style={{
                flex: 1,
                height: 4,
                borderRadius: i === 0 ? "4px 0 0 4px" : i === FLOW_STEPS.length - 1 ? "0 4px 4px 0" : 0,
                background: done
                  ? "var(--success)"
                  : active
                    ? "var(--accent)"
                    : "var(--border)",
                opacity: done || active ? 1 : 0.4,
                transition: "all 0.3s ease",
              }}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }} className="muted">
        {FLOW_STEPS.map((step) => (
          <span
            key={step.status}
            style={{
              flex: 1,
              textAlign: "center",
              color: step.status === status ? "var(--accent)" : undefined,
              fontWeight: step.status === status ? 700 : 400,
            }}
          >
            {step.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function badgeClass(status: OrderStatus): string {
  switch (status) {
    case "SETTLED":
    case "REDEEMED":
      return "badge-success";
    case "AWAITING_PAYMENT":
      return "badge-neutral";
    case "PAYMENT_DETECTED":
    case "SETTLING":
    case "MINTED":
    case "REDEEMING":
      return "badge-warning";
    case "REDEEM_DEFAULTED":
      return "badge-danger";
    case "EXPIRED":
    case "FAILED":
      return "badge-danger";
    case "REFUNDED":
      return "badge-info";
    default:
      return "badge-neutral";
  }
}
