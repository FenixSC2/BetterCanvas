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

### Alternative targets

The repository also contains a `Procfile` and an Elastic Beanstalk workflow
([`deploy-backend.yml`](../.github/workflows/deploy-backend.yml)). Both run the same `app:app`
ASGI application and can be used instead of App Runner.
