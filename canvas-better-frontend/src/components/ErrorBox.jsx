export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="errorBox">
      <div className="errorTitle">Something went wrong</div>
      <div className="errorMsg">{String(error.message || error)}</div>
      {error.status ? <div className="muted">HTTP {error.status}</div> : null}
    </div>
  );
}
