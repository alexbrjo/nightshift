/**
 * Lab-themed sidebar icons. All use `stroke="currentColor"` so the active
 * sidebar button's moon-glow color automatically tints them.
 */

const baseProps = {
  viewBox: "0 0 24 24",
  width: 20,
  height: 20,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Pipette / dropper — the project workspace. */
export function DropperIcon() {
  return (
    <svg {...baseProps} aria-hidden="true">
      {/* squeeze bulb */}
      <ellipse cx="12" cy="3.5" rx="3" ry="1.8" />
      {/* glass barrel */}
      <line x1="10.5" y1="5" x2="10.5" y2="14" />
      <line x1="13.5" y1="5" x2="13.5" y2="14" />
      {/* graduation mark */}
      <line x1="10.5" y1="9" x2="13.5" y2="9" />
      {/* tapered tip */}
      <path d="M10.5 14 L12 18 L13.5 14" />
      {/* falling drop */}
      <path d="M12 20 q-0.9 1.2 0 2 q0.9 -0.8 0 -2 z" />
    </svg>
  );
}

/** Filing cabinet — saved collections. */
export function CabinetIcon() {
  return (
    <svg {...baseProps} aria-hidden="true">
      {/* outer cabinet */}
      <rect x="4" y="3.5" width="16" height="17" rx="1.5" />
      {/* drawer dividers */}
      <line x1="4" y1="9.5" x2="20" y2="9.5" />
      <line x1="4" y1="15" x2="20" y2="15" />
      {/* pull handles */}
      <line x1="10" y1="6.5" x2="14" y2="6.5" />
      <line x1="10" y1="12" x2="14" y2="12" />
      <line x1="10" y1="17.5" x2="14" y2="17.5" />
    </svg>
  );
}

/** Test tube with liquid — inference jobs. */
export function TestTubeIcon() {
  return (
    <svg {...baseProps} aria-hidden="true">
      {/* lip overhang */}
      <line x1="8" y1="3" x2="16" y2="3" />
      {/* tube body with rounded bottom */}
      <path d="M9.5 3 V16.5 a2.5 2.5 0 0 0 5 0 V3" />
      {/* liquid surface */}
      <line x1="9.5" y1="13" x2="14.5" y2="13" />
      {/* a couple of bubbles */}
      <circle cx="11" cy="15.5" r="0.5" />
      <circle cx="13" cy="17" r="0.5" />
    </svg>
  );
}

/** Test tube rack — multi-experiment / agent designer. */
export function RackIcon() {
  return (
    <svg {...baseProps} aria-hidden="true">
      {/* three tubes */}
      <path d="M6 4 V19 a1.5 1.5 0 0 0 3 0 V4" />
      <path d="M10.5 4 V19 a1.5 1.5 0 0 0 3 0 V4" />
      <path d="M15 4 V19 a1.5 1.5 0 0 0 3 0 V4" />
      {/* tube lips */}
      <line x1="5.5" y1="4" x2="9.5" y2="4" />
      <line x1="10" y1="4" x2="14" y2="4" />
      <line x1="14.5" y1="4" x2="18.5" y2="4" />
      {/* rack support bar */}
      <line x1="4" y1="13" x2="20" y2="13" />
    </svg>
  );
}

/** Crescent moon — the app logo (Nightshift). */
export function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 14.5 A8 8 0 1 1 9.5 4 a6.5 6.5 0 0 0 10.5 10.5 z" />
    </svg>
  );
}
