import { useEffect, useState } from "react";
import { canvasApi } from "../api/canvasApi";
import { Loading } from "../components/Loading";
import { ErrorBox } from "../components/ErrorBox";

export function MyInformation() {
  const [profile, setProfile] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setErr(null);

    canvasApi
      .getProfile({ signal: ac.signal })
      .then(setProfile)
      .catch((e) => {
        if (e.name !== "AbortError") setErr(e);
      })
      .finally(() => setLoading(false));

    return () => ac.abort();
  }, []);

  if (loading) return <Loading label="Loading profile…" />;
  if (err) return <ErrorBox error={err} />;
  if (!profile) return <div className="muted">No profile found.</div>;

  return (
    <div className="stack">
      <div className="card">
        <div className="cardBody">
          <div className="row">
            {profile.avatar_url ? (
              <img className="avatar" src={profile.avatar_url} alt="avatar" />
            ) : (
              <div className="avatar placeholder" />
            )}

            <div>
              <div className="h2">{profile.name || "Unknown name"}</div>
              <div className="muted">
                User ID: <span className="mono">{profile.id}</span>
              </div>
              {profile.primary_email ? (
                <div className="muted">
                  Email: <span className="mono">{profile.primary_email}</span>
                </div>
              ) : null}
              {profile.sortable_name ? (
                <div className="muted">
                  Sortable: <span className="mono">{profile.sortable_name}</span>
                </div>
              ) : null}
              {profile.short_name ? (
                <div className="muted">
                  Short: <span className="mono">{profile.short_name}</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="muted">
        Tip: this tab is powered by <span className="mono">GET /api/profile</span>.
      </div>
    </div>
  );
}
