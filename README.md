# Kalos — DEXA Body Composition Platform

Two apps, one database:
- **Member Dashboard** (`/`) — Members view scan history, upload PDFs, track progress
- **MemberGPT** (`/coach`) — Coaches ask natural-language questions about member data
- **DB Viewer** (`/dbviewer`) — Dev tool for inspecting and editing data live

---

## Stack

| Layer | Tech | Why |
|---|---|---|
| Backend | Python + FastAPI | Fast to write, async, great for streaming responses |
| Database | SQLite | Zero setup, single file, enough for demo scale |
| AI | Google Gemini 2.5 Flash | Free tier, handles PDF vision + chat in one API |
| Frontend | Plain HTML + CSS + JS | No build step, easy to deploy, fast to iterate |

---

## Quick Start

### 1. Install

```bash

pip install -r requirements.txt
```

### 2. Get a free Gemini API key

https://aistudio.google.com/app/apikey

### 3. Set environment variable

Create `.env`:
```
GEMINI_API_KEY=your-key-here
```

Or set in terminal:

Windows CMD: `set GEMINI_API_KEY=your-key`
PowerShell: `$env:GEMINI_API_KEY="your-key"`
Mac/Linux: `export GEMINI_API_KEY=your-key`

### 4. Run

```bash

uvicorn main:app --reload --port 8000
```

- http://localhost:8000 → Member Dashboard
- http://localhost:8000/coach → MemberGPT
- http://localhost:8000/dbviewer → DB Viewer

---

## Demo Accounts (password: `demo123`)

| Email | Name | Scans | Persona |
|---|---|---|---|
| sarah@kalos.com | Sarah Chen | 1 | First scan |
| jordan@kalos.com | Jordan Rivera | 2 | Second scan |
| alex@kalos.com | Alex Thompson | 3 | Returning |
| maya@kalos.com | Maya Patel | 5 | Long-term trends |
| chris@kalos.com | Chris Morgan | 4 | Returning |

---

## Project Structure

```
kalos/
├── main.py                 # FastAPI app entry point
├── database.py             # SQLite schema + seed data
├── logger.py               # Colored console + file logging
├── requirements.txt
├── kalos.js                # Unified frontend JavaScript
├── dashboard.html          # Member Dashboard
├── coach.html              # MemberGPT Coach
├── dbviewer.html           # DB Viewer
├── style.css               # Shared design system
├── favicon.svg
└── routes/
    ├── __init__.py
    ├── auth.py             # Login / logout / session
    ├── scans.py            # PDF upload, Gemini extraction, manual entry
    ├── chat.py             # MemberGPT streaming chat
    └── dbviewer.py         # Live DB viewer with inline editing
```

---

## Features

### Member Dashboard
- Email/password auth with session cookies
- Persona-aware UI — different layout for 1, 2, or 3+ scans
- PDF upload → Gemini vision extracts DEXA data → appears instantly
- Manual entry fallback if PDF extraction fails
- Regional lean mass breakdown, trend charts, scan history
- Skeleton loaders, drag-and-drop, date override for testing

### MemberGPT
- No auth required (coach tool — per assignment spec)
- Member checkboxes — filter to specific members
- Only selected members' data sent to Gemini (saves tokens)
- Question templates auto-fill based on selection
- Streaming responses with stop button
- Conversation history maintained per session

### DB Viewer
- Live auto-refresh every 3 seconds
- Inline cell editing with validation (client + server)
- Sticky table headers, horizontal scroll
- Activity log, reset and re-seed button

---

## Deploy to Render (free)

1. Push to GitHub
2. New Web Service on render.com
3. Settings:
   
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Add env var: `GEMINI_API_KEY=your-key`

**Free tier note:** Spins down after 15 min. SQLite resets on redeploy but re-seeds automatically.

---

## Production Notes

- Sessions are in-memory → use Redis in production
- Passwords use SHA-256 → use bcrypt + proper auth in production
- SQLite → use PostgreSQL for production scale
- Gemini free tier → rate limits apply under heavy load
