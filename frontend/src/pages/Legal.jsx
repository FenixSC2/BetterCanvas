// src/pages/Legal.jsx
// Privacy policy and terms of use. Reachable at #privacy and #terms whether or not you're signed in.

const EFFECTIVE_DATE = "October 7, 2026";
const SUPPORT_EMAIL = "support@canvassist.com";

function LegalLayout({ title, children }) {
  return (
    <div className="landing legalPage">
      <header className="landingNav">
        <a className="brand" href="#" aria-label="CanvAssist home">
          <div className="brandLogomark" aria-hidden="true">CA</div>
          <div className="brandTitle">CanvAssist</div>
        </a>
        <nav className="landingNavLinks" aria-label="Legal">
          <a href="#" className="btn">Back to CanvAssist</a>
        </nav>
      </header>

      <main className="legalBody">
        <h1 className="legalTitle">{title}</h1>
        <p className="muted">Effective {EFFECTIVE_DATE}</p>
        {children}
      </main>

      <LegalFooter />
    </div>
  );
}

export function LegalFooter() {
  return (
    <footer className="landingFooter muted">
      <span>
        CanvAssist is an independent student project and is not affiliated with Instructure, Canvas, or
        Northeastern University.
      </span>
      <span>
        <a href="#privacy">Privacy</a> · <a href="#terms">Terms</a> ·{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </span>
    </footer>
  );
}

export function PrivacyPolicy() {
  return (
    <LegalLayout title="Privacy Policy">
      <p>
        CanvAssist is a free, independent student project that gives Northeastern students a cleaner view of
        their Canvas courses. This page explains what we collect, why, and the choices you have. The short
        version: we collect only what the app needs to work, we don't sell or share your data, and you can
        delete your account at any time.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account details.</strong> Your email address and your password. Passwords are stored only as
          a one-way bcrypt hash; we can't see them.
        </li>
        <li>
          <strong>Your Canvas access token.</strong> The token you give us is encrypted before it's stored and
          is used only to request your own course data from Northeastern's Canvas while you use the app.
        </li>
        <li>
          <strong>Canvas data.</strong> Courses, assignments, grades, announcements, and discussions are fetched
          from Canvas when you ask for them. Our server keeps them in memory for up to about 10 minutes to stay
          fast. We don't store your grades in our database.
        </li>
        <li>
          <strong>Things you save in CanvAssist.</strong> To-dos, workload estimates, completion marks, grade
          and weight overrides, personal due dates, hidden assignments, and grade-scale preferences, so they
          follow you across devices.
        </li>
        <li>
          <strong>Basic usage counts.</strong> We record which days each account was active and keep that for
          90 days, so we can see how many people use the app daily, weekly, and monthly. Demo visits are counted
          as anonymous sessions. We don't track which pages you view or what you click.
        </li>
        <li>
          <strong>Server logs.</strong> Like most websites, our hosting provider logs requests (including IP
          address, time, and the page requested). We use these only to keep the service secure and fix
          problems.
        </li>
      </ul>

      <h2>Cookies and browser storage</h2>
      <p>
        We set one cookie, <code>session_id</code>, which keeps you signed in. It's strictly necessary for the
        app to work, can't be read by page scripts, and expires after 30 days (24 hours for the demo). We
        don't use advertising or third-party tracking cookies, so there's nothing to opt out of.
      </p>
      <p>
        The app also uses your browser's local storage on your device for preferences (theme, font, layout),
        some of your planning data, and a snapshot of your grades used for grade-change notifications. Signing
        out clears the grade snapshot; deleting your account clears everything on that device, and you can
        always clear site data in your browser.
      </p>

      <h2>How we use it</h2>
      <p>
        Only to run CanvAssist: signing you in, showing your Canvas data, saving your settings, sending
        password-reset emails you request, keeping the service secure, and understanding overall usage. We
        don't sell your data, show ads, or use it to build profiles.
      </p>

      <h2>Who we share it with</h2>
      <p>No one, except the services the app runs on:</p>
      <ul>
        <li>
          <strong>Amazon Web Services</strong> hosts the app and database (in the United States) and sends
          password-reset emails.
        </li>
        <li>
          <strong>Northeastern's Canvas (Instructure)</strong> receives requests made with your token, the same
          as when you use Canvas yourself.
        </li>
      </ul>
      <p>
        We would disclose information only if required by law. The site loads no third-party scripts, fonts,
        or analytics.
      </p>

      <h2>Security</h2>
      <p>
        All traffic uses HTTPS. Passwords are hashed, Canvas tokens are encrypted at rest, and sign-in and
        write requests are rate-limited. No system is perfectly secure, but we treat your token like a
        password.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>
          <strong>Delete your account</strong> in Settings → Account. This permanently removes your account,
          your stored token, everything you've saved, and your usage records.
        </li>
        <li>
          <strong>Revoke your token</strong> in Settings → Account, or in Canvas under Account → Settings →
          Approved Integrations. Revoking it in Canvas cuts off access immediately.
        </li>
        <li>
          <strong>Questions, or a copy of your data:</strong> email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </li>
      </ul>

      <h2>Children</h2>
      <p>CanvAssist is meant for university students and isn't directed to children under 13.</p>

      <h2>Changes</h2>
      <p>
        If this policy changes, we'll update the date at the top of this page. Significant changes will be
        noted in the app.
      </p>
    </LegalLayout>
  );
}

export function TermsOfUse() {
  return (
    <LegalLayout title="Terms of Use">
      <p>
        These terms cover your use of CanvAssist. By creating an account or using the demo, you agree to them.
        Please also read the <a href="#privacy">Privacy Policy</a>.
      </p>

      <h2>What CanvAssist is</h2>
      <p>
        CanvAssist is a free, independent student project that displays your Canvas data in a different
        layout and adds planning tools. It is not affiliated with, endorsed by, or supported by Instructure
        (the maker of Canvas) or Northeastern University. Canvas is a trademark of Instructure, Inc.
      </p>

      <h2>Your account and token</h2>
      <ul>
        <li>Accounts currently work only with Northeastern University's Canvas.</li>
        <li>Keep your password private. You're responsible for activity on your account.</li>
        <li>
          By adding a Canvas token, you authorize CanvAssist to use it to read your own data from Canvas on
          your behalf. You can revoke it at any time in Settings or in Canvas.
        </li>
        <li>Follow your school's policies when using CanvAssist.</li>
      </ul>

      <h2>Acceptable use</h2>
      <p>Don't:</p>
      <ul>
        <li>access anyone else's account or data;</li>
        <li>attack, overload, scrape, or try to break the service or its security;</li>
        <li>use CanvAssist for anything unlawful or to violate academic integrity rules.</li>
      </ul>

      <h2>Accuracy</h2>
      <p>
        Grade predictions, workload estimates, and reminders are informational. Data can be delayed or
        incomplete, and calculations may not match how your instructor grades. Canvas and your instructors
        are the official source for grades, due dates, and announcements. Always check there before relying
        on something important.
      </p>

      <h2>Availability</h2>
      <p>
        CanvAssist is provided free of charge, as is and as available, without warranties of any kind. It may
        change, be unavailable, or shut down at any time. To the fullest extent the law allows, CanvAssist and
        its developer aren't liable for any indirect or consequential damages, or for lost data, missed
        deadlines, or grades, arising from your use of the service.
      </p>

      <h2>Ending your use</h2>
      <p>
        You can stop using CanvAssist and delete your account at any time in Settings → Account. We may
        suspend accounts that break these terms or put the service or other users at risk.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms; the date at the top will change when we do. Continuing to use CanvAssist
        after an update means you accept the new terms.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </p>
    </LegalLayout>
  );
}
