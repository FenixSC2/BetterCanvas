export function SettingsButton({ onClick, className = "" }) {
  return (
    <button
      type="button"
      className={`iconBtn ${className}`.trim()}
      onClick={onClick}
      aria-label="Open settings"
      title="Settings"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ display: "block" }}
      >
        {/* inner circle stays perfectly centered */}
        <path
          d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
          stroke="currentColor"
          strokeWidth="2"
        />

        {/* outer gear nudged up slightly to match circle */}
        <g transform="translate(0,-2)">
          <path
            d="M19.4 15a8.5 8.5 0 0 0 .1-1 8.5 8.5 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a8.7 8.7 0 0 0-1.7-1l-.4-2.6H9l-.4 2.6a8.7 8.7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a8.5 8.5 0 0 0-.1 1 8.5 8.5 0 0 0 .1 1l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.4 2.6h6l.4-2.6c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </button>
  );
}
