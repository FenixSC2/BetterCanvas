# Deployment

Production runs on AWS:

| Piece | Hosting | How it ships |
| --- | --- | --- |
| Frontend (`frontend/`) | S3 bucket behind CloudFront at `canvassist.com` | GitHub Actions: [`deploy-frontend.yml`](../.github/workflows/deploy-frontend.yml) |
| Backend (`backend/`) | AWS App Runner at `api.canvassist.com` | App Runner source build from [`backend/apprunner.yaml`](../backend/apprunner.yaml) |
| Database | PostgreSQL | Connection string in Secrets Manager |
| Email | Amazon SES over SMTP | Credentials in Secrets Manager |

## Frontend

On every push to `main` or `deployed` that touches `frontend/`, the workflow does the following:

1. Installs dependencies and runs `npm run lint`, so a lint failure blocks the deploy.
2. Builds with `VITE_API_BASE_URL` taken from the repository secret.
3. Syncs `dist/` to S3. Hashed assets are cached as immutable, and `index.html` is served `no-cache`.
4. Invalidates the CloudFront distribution.

Required repository secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
`S3_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID`, `VITE_API_BASE_URL`.

## Backend

`backend/apprunner.yaml` defines the App Runner build and run steps: Python 3.11, with gunicorn
running Uvicorn workers on port 8080. It also sets the non-secret environment variables.
`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY` and the SMTP credentials are injected from AWS Secrets
Manager.

On startup the app verifies database connectivity and creates any missing tables. In a cloud
runtime it refuses to start if the database is unreachable.

Production settings to keep in mind:

- `TOKEN_ENCRYPTION_KEY` must stay the same across deploys. Changing it makes every stored
  Canvas token unreadable, and users have to re-enter their tokens.
- `SECURE_COOKIES=true` and `ALLOWED_ORIGINS` must list the frontend origin. The session cookie
  uses `SameSite=None` because the frontend and the API are on different subdomains.
- Demo sessions are stateless signed tokens, so they survive restarts and scale across instances.
- `ADMIN_EMAILS` (comma-separated) lists the accounts that see Settings → Usage. Their own
  activity is excluded from the counts.
- `TRUSTED_PROXY_HOPS` (default 1) is how many proxies in front of the app append to
  `X-Forwarded-For`. IP-based rate limits key on that entry from the right.

### Canvas OAuth

Canvas's API policy requires apps used by more than one person to get tokens through OAuth with a
developer key issued by the school. The OAuth flow (`backend/canvas_oauth.py`) stays off until
these are set:

| Variable | Value |
|---|---|
| `CANVAS_OAUTH_CLIENT_ID` | the developer key's client ID (env var) |
| `CANVAS_OAUTH_CLIENT_SECRET` | the key's secret (Secrets Manager, like `DATABASE_URL`) |
| `CANVAS_OAUTH_REDIRECT_URI` | `https://api.canvassist.com/api/auth/canvas/callback` (must match the key exactly) |
| `CANVAS_OAUTH_SCOPES` | optional; space-separated `url:GET\|/api/v1/...` scopes if the key enforces scopes |

When those are present, the token page shows **Connect Canvas** instead of the paste-a-token form,
pasted tokens are refused, and users who still have one are asked to reconnect once. Set
`CANVAS_ALLOW_PERSONAL_TOKENS=true` to keep accepting pasted tokens during a transition.

The app only reads from Canvas. It calls these GET endpoints:

- `/api/v1/users/self/profile`, `/api/v1/users/self/enrollments`
- `/api/v1/courses/:id`, `/api/v1/courses/:id/tabs`
- `/api/v1/courses/:id/assignments`, `/api/v1/courses/:id/assignments/:id`,
  `/api/v1/courses/:id/assignment_groups`
- `/api/v1/courses/:id/discussion_topics`, `/api/v1/courses/:id/discussion_topics/:id/view`
- `/api/v1/announcements`, `/api/v1/planner/items`

### Running elsewhere

`backend/Procfile` runs the same `app:app` ASGI application with Uvicorn, for hosts that use
Procfiles. Any ASGI server works.
