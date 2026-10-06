// src/pages/Landing.jsx
// Public front door: explains the project and offers a no-account demo.

const FEATURES = [
  {
    title: "Weekly planner with workload",
    body: "Estimate hours per assignment, split big tasks across days, and see at a glance when a day is over capacity.",
    icon: (
      <path d="M4 6h16M4 12h10M4 18h6M17 14v6m-3-3h6" />
    ),
  },
  {
    title: "Grade what-ifs",
    body: "Predict scores on upcoming work, override weights, and find the minimum you need on the final to hit your target.",
    icon: <path d="M5 19V9m7 10V5m7 14v-7" />,
  },
  {
    title: "Every deadline in one list",
    body: "Upcoming, missing, and undated assignments across all courses, cross-checked against Canvas so nothing slips.",
    icon: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  },
  {
    title: "Personal to-dos",
    body: "Add your own tasks with recurring schedules; anything with a due date shows up in the planner next to coursework.",
    icon: <path d="m5 12 4 4L19 6" />,
  },
  {
    title: "Announcements & discussions",
    body: "Unread announcements and threaded discussions from every course, without clicking through each one.",
    icon: <path d="M4 5h16v11H8l-4 4V5Z" />,
  },
  {
    title: "Make it yours",
    body: "Light, dark, and custom themes, compact density, font choices, and a customizable home dashboard.",
    icon: <path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5s.8-1.5 2-1.5H17a4 4 0 0 0 4-4c0-4.4-4-8.5-9-8.5ZM7.5 11h.01M10 7h.01M15 7h.01" />,
  },
];

const STACK = ["React 19", "Vite", "FastAPI", "SQLAlchemy", "PostgreSQL", "AWS S3 + CloudFront", "AWS App Runner", "GitHub Actions"];

const ENGINEERING = [
  "Canvas API tokens are encrypted at rest (Fernet) and never sent back to the browser.",
  "Session auth via httpOnly cookies, bcrypt password hashing, and rate-limited auth endpoints.",
  "Server-side caching and parallel Canvas requests keep dashboards fast on large course loads.",
  "Demo mode runs on stateless signed sessions and generated data, isolated from real accounts.",
];

function Screenshot({ name, alt, eager = false }) {
  return (
    <picture>
      <source srcSet={`/screenshots/${name}-dark.jpg`} media="(prefers-color-scheme: dark)" />
      <img
        src={`/screenshots/${name}-light.jpg`}
        alt={alt}
        width="1600"
        height="1000"
        loading={eager ? "eager" : "lazy"}
        decoding="async"
      />
    </picture>
  );
}

export function Landing({ onTryDemo }) {
  function goToLogin(e) {
    e.preventDefault();
    window.location.hash = "#login";
  }

  return (
    <div className="landing">
      <header className="landingNav">
        <a className="brand" href="#" aria-label="CanvAssist home">
          <div className="brandLogomark" aria-hidden="true">CA</div>
          <div className="brandTitle">CanvAssist</div>
        </a>
        <nav className="landingNavLinks" aria-label="Primary">
          <a href="#features" onClick={(e) => { e.preventDefault(); document.getElementById("features")?.scrollIntoView({ behavior: "smooth" }); }}>
            Features
          </a>
          <a href="#login" className="btn" onClick={goToLogin}>Sign in</a>
        </nav>
      </header>

      <main>
        <section className="landingHero">
          <p className="landingEyebrow">Built by a Northeastern student, for students</p>
          <h1 className="landingTitle">
            Canvas, <span className="landingTitleAccent">but calmer.</span>
          </h1>
          <p className="landingLede">
            CanvAssist turns Canvas into one focused dashboard: a weekly planner that knows how long
            your work takes, grade calculators that answer "what do I need on the final?", and every
            deadline across every course in one place.
          </p>
          <div className="landingCtas">
            <button type="button" className="authButton landingCtaPrimary" onClick={onTryDemo}>
              Try the live demo
            </button>
            <a href="#login" className="authButton authButtonSecondary" onClick={goToLogin}>
              Sign in
            </a>
          </div>
          <p className="landingNote">No account needed. The demo uses realistic sample courses.</p>

          <div className="landingShot landingShotHero">
            <Screenshot name="planner" alt="Weekly Planner showing assignments with workload estimates across a week" eager />
          </div>
        </section>

        <section id="features" className="landingSection">
          <h2 className="landingH2">Everything Canvas spreads across a dozen pages</h2>
          <div className="landingFeatures">
            {FEATURES.map((f) => (
              <article key={f.title} className="landingFeature">
                <svg className="landingFeatureIcon" viewBox="0 0 24 24" aria-hidden="true">
                  {f.icon}
                </svg>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landingSection landingSplit">
          <div className="landingSplitText">
            <h2 className="landingH2">Know where you stand</h2>
            <p>
              The home dashboard pulls what matters to the top: what's due today, what's missing, and
              how each course is going, with grades you can hide with one toggle.
            </p>
          </div>
          <div className="landingShot">
            <Screenshot name="info" alt="Home dashboard with today's items, GPA, and course grades" />
          </div>
        </section>

        <section className="landingSection landingSplit landingSplitReverse">
          <div className="landingSplitText">
            <h2 className="landingH2">Plan for the grade you want</h2>
            <p>
              Pick a target letter and CanvAssist works backward from your real Canvas scores,
              assignment weights, and predictions to show what you need on the work that's left.
            </p>
          </div>
          <div className="landingShot">
            <Screenshot name="grades" alt="Final grade calculator with target grade and projected score" />
          </div>
        </section>

        <section className="landingSection landingEngineering">
          <h2 className="landingH2">Under the hood</h2>
          <p className="landingSectionLede">
            A full-stack project: a React single-page app talking to a FastAPI service that proxies,
            caches, and enriches the Canvas LMS API.
          </p>
          <ul className="landingStack" aria-label="Technology stack">
            {STACK.map((s) => <li key={s}>{s}</li>)}
          </ul>
          <ul className="landingEngList">
            {ENGINEERING.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </section>

        <section className="landingSection landingFinal">
          <h2 className="landingH2">See it with real-looking data</h2>
          <p className="landingSectionLede">
            The demo loads three sample courses with assignments, grades, discussions, and to-dos.
            Nothing you do there touches a real account.
          </p>
          <div className="landingCtas">
            <button type="button" className="authButton landingCtaPrimary" onClick={onTryDemo}>
              Try the live demo
            </button>
          </div>
        </section>
      </main>

      <footer className="landingFooter muted">
        <span>
          CanvAssist is an independent student project and is not affiliated with Instructure or Canvas.
          Accounts are currently limited to Northeastern University students.
        </span>
        <span>
          <a href="mailto:support@canvassist.com">support@canvassist.com</a>
        </span>
      </footer>
    </div>
  );
}
