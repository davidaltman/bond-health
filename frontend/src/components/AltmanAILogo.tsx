export function AltmanAILogo({ size = 28 }: { size?: number }) {
  return (
    <div className="brand-logo" style={{ fontSize: size * 0.5 }}>
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="url(#altman-ai-gradient)" />
        <path
          d="M16 8l5.5 16h-2.9l-1.15-3.5h-6.9L9.4 24H6.5L12 8h4zm-2 2.6L11.5 18h5l-2.5-7.4z"
          fill="white"
        />
        <defs>
          <linearGradient id="altman-ai-gradient" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop stopColor="#6C5CE7" />
            <stop offset="1" stopColor="#00B8D9" />
          </linearGradient>
        </defs>
      </svg>
      <span className="brand-wordmark">
        Altman<span className="brand-wordmark-accent">AI</span>
      </span>
    </div>
  );
}
