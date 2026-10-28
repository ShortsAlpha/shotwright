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

export const SparkleIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </svg>
);

export const CheckIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export const AlertIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M12 3l9.5 17h-19z" />
    <path d="M12 10v4" />
    <path d="M12 17.5v.01" />
  </svg>
);

export const FolderIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
  </svg>
);

export const PointerIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M12 10.5V9a1.5 1.5 0 0 1 3 0v2" />
    <path d="M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-4.6-2.2L4 15.6a1.6 1.6 0 0 1 2.4-2.1L9 16V11" />
  </svg>
);

export const SwipeIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M12 20V4" />
    <path d="M7 9l5-5 5 5" />
  </svg>
);

export const BookmarkIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M6 3.5h12V21l-6-4-6 4z" />
  </svg>
);

export const KeyboardIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" />
  </svg>
);

export const FlagIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M5 21V4" />
    <path d="M5 4h11l-2 4 2 4H5" />
  </svg>
);

export const GlobeIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
  </svg>
);
