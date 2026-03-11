# CanvAssist Deployment Roadmap

Everything in this file that is **automated** will be handled by the GitHub Actions
workflows on every push to `main`.
Everything marked **manual** is a one-time setup step you do yourself in the AWS
console, AWS CLI, or your domain registrar.

---

## Phase 1 — Domain & SSL  *(manual)*

### 1.1 Buy a domain
- Go to **AWS Route 53 → Registered domains → Register domain**
- Recommended: pick a `.com` (~$12/yr) or `.app` (~$14/yr)
- Route 53 will automatically create a hosted zone for you

### 1.2 Request an SSL certificate
> ⚠️ The certificate **must** be created in `us-east-1` (N. Virginia) for CloudFront to use it.

1. Open **AWS Certificate Manager** — switch region to `us-east-1`
2. Click **Request a public certificate**
3. Add these domain names:
   - `yourdomain.com`
   - `www.yourdomain.com`  *(optional redirect)*
   - `app.yourdomain.com`  *(frontend)*
   - `api.yourdomain.com`  *(backend)*
4. Choose **DNS validation**, click through
5. ACM will show you CNAME records — click **Create records in Route 53** (instant)
6. Wait ~2 minutes for status to show **Issued** — copy the certificate ARN

---

## Phase 2 — Database  *(manual)*

### 2.1 Launch RDS PostgreSQL
1. Open **RDS → Create database**
   - Engine: **PostgreSQL 16**
   - Template: **Free tier** (t3.micro — or t3.small for more reliability)
   - DB instance identifier: `canvassist-db`
   - Master username: `canvassist`
   - Auto-generate password (save it!)
   - **Connectivity**: make note of the VPC and subnet group — you will need it for EB
   - **Public access**: No (EB will access it via VPC)
2. Once available, copy the **Endpoint** (looks like `canvassist-db.xxxx.us-east-1.rds.amazonaws.com`)
3. Build your `DATABASE_URL`:
   ```
   postgresql://canvassist:<PASSWORD>@<ENDPOINT>:5432/canvassist
   ```

---

## Phase 3 — Backend (Elastic Beanstalk)  *(manual setup, then automated deploys)*

### 3.1 Generate the token encryption key
Run this once locally and save the output — you will need it as an env var:
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

### 3.2 Create an EB application & environment
1. Install the EB CLI: `pip install awsebcli`
2. From the `backend/` directory:
   ```bash
   eb init canvassist --platform "Python 3.11" --region us-east-1
   eb create canvassist-prod --single  # single-instance to start (no load balancer cost)
   ```
3. In the AWS console → Elastic Beanstalk → `canvassist-prod` → **Configuration → Software**,
   add these environment properties:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | `postgresql://canvassist:<PW>@<RDS_ENDPOINT>:5432/canvassist` |
   | `TOKEN_ENCRYPTION_KEY` | *(the key you generated above)* |
   | `ALLOWED_ORIGINS` | `https://app.yourdomain.com` |
   | `SECURE_COOKIES` | `true` |
   | `CANVAS_BASE_URL` | `https://canvas.instructure.com` *(or your school's Canvas URL)* |

### 3.3 Point `api.yourdomain.com` to the EB environment
1. In the EB console, note the environment URL (e.g. `canvassist-prod.us-east-1.elasticbeanstalk.com`)
2. In **Route 53 → Hosted zones → yourdomain.com → Create record**:
   - Name: `api`
   - Type: `CNAME`
   - Value: EB environment URL

> For HTTPS on the API, configure the EB environment's load balancer to use the ACM cert (if you used `--single`, you add HTTPS by attaching a load balancer later — or use Nginx on the instance).

---

## Phase 4 — Frontend (S3 + CloudFront)  *(manual setup, then automated deploys)*

### 4.1 Create an S3 bucket
1. Open **S3 → Create bucket**
   - Name: `canvassist-frontend` *(must be globally unique)*
   - Region: `us-east-1`
   - **Block all public access**: leave checked (CloudFront will access it, not the public)
2. Leave everything else as defaults

### 4.2 Create a CloudFront distribution
1. Open **CloudFront → Create distribution**
2. **Origin domain**: select your S3 bucket
3. **Origin access**: choose **Origin access control (OAC)** → create a new OAC
4. CloudFront will show you a bucket policy to copy — apply it to your S3 bucket under Permissions
5. **Viewer protocol policy**: Redirect HTTP to HTTPS
6. **Alternate domain names (CNAMEs)**: `app.yourdomain.com`
7. **Custom SSL certificate**: select the cert you created in Phase 1
8. **Default root object**: `index.html`
9. **Custom error pages**: Add a rule — HTTP 403 → `/index.html` → 200
   *(This makes React's hash-based routing work for direct URL loads)*
10. Copy the **Distribution domain name** and **Distribution ID**

### 4.3 Point `app.yourdomain.com` to CloudFront
1. In **Route 53 → Hosted zones → yourdomain.com → Create record**:
   - Name: `app`
   - Type: `A`
   - Toggle **Alias** on
   - Route traffic to: **Alias to CloudFront distribution** → select yours

---

## Phase 5 — GitHub Actions Secrets  *(manual)*

In your GitHub repo → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM user access key (see note below) |
| `AWS_SECRET_ACCESS_KEY` | IAM user secret key |
| `AWS_REGION` | `us-east-1` |
| `S3_BUCKET` | `canvassist-frontend` *(your S3 bucket name)* |
| `CLOUDFRONT_DISTRIBUTION_ID` | From CloudFront console |
| `VITE_API_BASE_URL` | `https://api.yourdomain.com` |
| `EB_APPLICATION_NAME` | `canvassist` |
| `EB_ENVIRONMENT_NAME` | `canvassist-prod` |
| `EB_S3_BUCKET` | The S3 bucket EB created for deployments (visible in EB console) |

**Creating the IAM deploy user:**
1. Open **IAM → Users → Create user**
   - Name: `canvassist-github-deploy`
2. Attach these managed policies:
   - `AmazonS3FullAccess` (scoped to your buckets if desired)
   - `CloudFrontFullAccess`
   - `AdministratorAccess-AWSElasticBeanstalk`
3. Create an **Access key** (type: CI/CD) and save both values as secrets above

---

## Phase 6 — First Deploy  *(manual, one-time)*

After all AWS infrastructure is set up:

```bash
# From project root
git add .
git commit -m "Add AWS deployment configuration"
git push origin main
```

GitHub Actions will:
1. Build the React app with your production `VITE_API_BASE_URL`
2. Upload it to S3 and invalidate CloudFront
3. Zip and deploy the FastAPI backend to Elastic Beanstalk

---

## What Is Automated After Setup

| Trigger | What happens |
|---|---|
| Push to `main` with changes in `canvas-better-frontend-themed/` | React rebuild → S3 sync → CloudFront cache bust |
| Push to `main` with changes in `backend/` | Backend zip → EB deploy → waits for health |

---

## Future Improvements (optional)

- **AWS Secrets Manager** — store `TOKEN_ENCRYPTION_KEY` and `DATABASE_URL` there instead of EB env vars for better secret rotation
- **EB with load balancer** — enables HTTPS termination at the ALB + blue/green deploys
- **RDS automated backups** — enable in RDS settings (already on by default, verify retention period)
- **CloudWatch alarms** — set up alerts for 5xx error rates and EB health
- **In-memory sessions → DB sessions** — the current session store resets on EB instance restart; move `_sessions` to a DB table for zero-downtime deploys
