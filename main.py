from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import os

from dotenv import load_dotenv
load_dotenv()

from database import init_db, get_db, hash_password
from routes.auth import router as auth_router
from routes.scans import router as scans_router
from routes.chat import router as chat_router
from routes.dbviewer import router as dbviewer_router
from logger import get_logger

log = get_logger("main")

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("=" * 50)
    log.info("  Kalos API starting up")
    log.info("=" * 50)
    init_db()
    yield
    log.info("Kalos API shutting down")

app = FastAPI(title="Kalos API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
app.include_router(auth_router,     prefix="/api")
app.include_router(scans_router,    prefix="/api")
app.include_router(chat_router,     prefix="/api")
app.include_router(dbviewer_router, prefix="/api")

# DB reset endpoint (dev only)
@app.post("/api/dbviewer/reset")
def reset_db():
    import os as _os
    from database import DB_PATH
    conn = get_db()
    conn.execute("DELETE FROM scans")
    conn.execute("DELETE FROM members")
    conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('members','scans')")
    conn.commit()
    conn.close()
    from database import _seed, get_db as gdb
    conn2 = gdb()
    _seed(conn2)
    conn2.close()
    log.warning("Database RESET and re-seeded by user")
    return {"ok": True}

# Frontend
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
#frontend_dir = os.path.abspath(os.path.join(BASE_DIR, "..", "frontend"))

frontend_dir = BASE_DIR


log.info(f"Frontend dir: {frontend_dir}")
log.info(f"Frontend exists: {os.path.exists(frontend_dir)}")

@app.get("/")
def serve_dashboard():
    return FileResponse(os.path.join(frontend_dir, "dashboard.html"))

@app.get("/coach")
def serve_coach():
    return FileResponse(os.path.join(frontend_dir, "coach.html"))

@app.get("/dbviewer")
def serve_dbviewer():
    return FileResponse(os.path.join(frontend_dir, "dbviewer.html"))

@app.get("/health")
def health():
    return {"status": "ok"}

app.mount("/static", StaticFiles(directory=frontend_dir), name="static")
