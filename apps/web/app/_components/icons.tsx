import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const RefreshIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);

export const PowerIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M12 2v10" />
    <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
  </svg>
);

export const PlayIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M7 4v16l13-8z" fill="currentColor" />
  </svg>
);

export const StopIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </svg>
);

export const HomeIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M3 11l9-7 9 7" />
    <path d="M5 10v10h14V10" />
  </svg>
);

export const PhoneIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <rect x="6" y="2" width="12" height="20" rx="3" />
    <path d="M11 18h2" />
  </svg>
);

export const Spinner = ({ className = "", ...props }: IconProps) => (
  <svg {...base} className={`animate-spin ${className}`} {...props}>
    <path d="M21 12a9 9 0 1 1-9-9" />
  </svg>
);

export const Logo = (props: IconProps) => (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden {...props}>
    <rect x="5" y="1.5" width="14" height="21" rx="3.5" fill="currentColor" />
    <rect x="8" y="6" width="8" height="2" rx="1" fill="white" opacity="0.9" />
    <rect x="8" y="10" width="8" height="8" rx="1.5" fill="white" opacity="0.55" />
  </svg>
);
