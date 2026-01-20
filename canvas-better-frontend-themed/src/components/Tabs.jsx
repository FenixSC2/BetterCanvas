export function Tabs({ tabs, activeKey, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button
          key={t.key}
          className={`tab ${activeKey === t.key ? "active" : ""}`}
          onClick={() => onChange(t.key)}
          type="button"
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
