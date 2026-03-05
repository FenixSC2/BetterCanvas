# Quick Start Guide - Canvas Better Auth System

## 5-Minute Setup

### 1. Install Backend Dependencies
```bash
cd backend
pip install -r requirements.txt
```

### 2. Run Backend
```bash
python app.py
```
You'll see:
```
INFO:     Uvicorn running on http://127.0.0.1:8000
INFO:     Application startup complete
```

Auto-generates on first run:
- `canvas_better.db` (SQLite database)
- Encryption keys for token storage

### 3. Install Frontend Dependencies
```bash
cd canvas-better-frontend-themed
npm install
```

### 4. Create Frontend Environment
Create `.env.local`:
```env
VITE_API_BASE_URL=http://localhost:8000
```

### 5. Run Frontend
```bash
npm run dev
```
Navigate to: http://localhost:5173

## First Login

### Step 1: Register
- Click **"Sign up"**
- Enter email and password (min 6 chars)
- Click **Create account**
- Auto-logged in!

### Step 2: Get Canvas Token
1. Go to your Canvas institution's URL
2. Click profile icon → **Settings**
3. Find **"Approved Integrations"** section
4. Click **"New Access Token"**
5. Name it: `Canvas Better`
6. Click **Generate Token**
7. **Copy the token** (you won't see it again)

### Step 3: Enter Canvas Token
1. Back on Canvas Better
2. Paste token in the form
3. Click **Save Token**
4. You're in! 🎉

## What You Can Do Now

✅ View your courses  
✅ See upcoming assignments  
✅ Plan your week  
✅ Track effort on assignments  
✅ Switch themes and density settings  
✅ Sign out from settings  

## Important Notes

- **Your token is encrypted** - Never stored in plaintext
- **30-day sessions** - You'll be logged out after 30 days of inactivity
- **Revoke anytime** - Enter TokenEntry page → click Revoke
- **Update token** - Submit new token anytime

## Production Deployment

Before deploying to production:

1. **Save encryption key**
   ```bash
   # After first run, copy from .env or logs
   export TOKEN_ENCRYPTION_KEY="your_key_here"
   ```

2. **Use PostgreSQL** instead of SQLite
   ```env
   DATABASE_URL=postgresql://user:password@localhost/canvas_better
   ```

3. **Use secure cookies**
   ```python
   # In app.py, update to:
   response.set_cookie(..., secure=True, httponly=True)
   ```

4. **Set strong session secret**
   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   # Set as SESSION_SECRET env var
   ```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Module not found" | Run `pip install -r requirements.txt` |
| Cookies not working | Ensure frontend has `VITE_API_BASE_URL` set |
| Login not working | Check backend is running on correct port |
| Token save failed | Verify token format from Canvas |
| "Coming soon" on Settings Account | User account info hasn't loaded yet |

## What's Protected?

These endpoints require a valid session:
- `GET /api/profile` - Your Canvas profile
- `GET /api/courses` - Your courses
- `GET /api/upcoming` - Your assignments
- `POST /api/auth/token` - Save Canvas token
- `GET /api/auth/token/status` - Check token exists
- `DELETE /api/auth/token` - Revoke token

These are public:
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout

## File Structure

```
canvas-better-frontend-themed/
├── src/
│   ├── pages/
│   │   ├── Login.jsx          ← Login form
│   │   ├── Register.jsx       ← Registration form
│   │   ├── TokenEntry.jsx     ← Canvas token entry
│   │   └── ...other pages
│   ├── hooks/
│   │   ├── useAuth.js         ← Auth context & login/register logic
│   │   └── ...other hooks
│   ├── components/
│   │   ├── SettingsModal.jsx  ← Updated with Account tab
│   │   └── ...other components
│   ├── api/
│   │   └── canvasApi.js       ← Updated with credentials
│   ├── App.jsx                ← Updated with AuthProvider
│   └── styles.css             ← Updated with auth styles

backend/
├── app.py                      ← Updated with auth endpoints
├── auth.py                     ← NEW: Auth module
└── requirements.txt            ← NEW: Auth dependencies
```

## API Endpoints Reference

### Auth Endpoints

```bash
# Register
curl -X POST http://localhost:8000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"mypassword"}'

# Login
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"mypassword"}' \
  -c cookies.txt

# Get current user
curl http://localhost:8000/api/auth/me -b cookies.txt

# Save token
curl -X POST http://localhost:8000/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"token":"your_canvas_token"}' \
  -b cookies.txt

# Check token exists
curl http://localhost:8000/api/auth/token/status -b cookies.txt

# Revoke token
curl -X DELETE http://localhost:8000/api/auth/token -b cookies.txt

# Logout
curl -X POST http://localhost:8000/api/auth/logout -b cookies.txt
```

---

**Ready to go!** Any issues? Check `AUTH_SYSTEM_COMPLETE.md` for detailed docs.
