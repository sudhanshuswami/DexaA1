from fastapi import APIRouter, HTTPException, Response, Request
from pydantic import BaseModel
import hashlib
import secrets
from database import get_db
from logger import get_logger

log = get_logger("auth")
router = APIRouter()

sessions: dict[str, int] = {}

class LoginRequest(BaseModel):
    email: str
    password: str

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def get_current_member(request: Request) -> int:
    token = request.cookies.get("session_token")
    if not token or token not in sessions:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return sessions[token]

@router.post("/auth/login")
def login(data: LoginRequest, response: Response):
    log.info(f"Login attempt → email={data.email}")
    conn = get_db()
    member = conn.execute("SELECT * FROM members WHERE email = ?", (data.email,)).fetchone()
    conn.close()

    if not member or member["password_hash"] != hash_password(data.password):
        log.warning(f"Login FAILED → email={data.email} (wrong credentials)")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = secrets.token_hex(32)
    sessions[token] = member["id"]
    response.set_cookie("session_token", token, httponly=True, samesite="lax", max_age=86400 * 7)
    log.info(f"Login SUCCESS → member_id={member['id']} name={member['name']} active_sessions={len(sessions)}")
    return {"id": member["id"], "name": member["name"], "email": member["email"], "goal": member["goal"]}

@router.post("/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get("session_token")
    mid = sessions.pop(token, None)
    response.delete_cookie("session_token")
    log.info(f"Logout → member_id={mid} active_sessions={len(sessions)}")
    return {"ok": True}

@router.get("/auth/me")
def me(request: Request):
    token = request.cookies.get("session_token")
    if not token or token not in sessions:
        raise HTTPException(status_code=401, detail="Not authenticated")
    member_id = sessions[token]
    conn = get_db()
    member = conn.execute("SELECT id, name, email, age, height_cm, goal FROM members WHERE id = ?", (member_id,)).fetchone()
    conn.close()
    if not member:
        raise HTTPException(status_code=404)
    log.debug(f"Session check OK → member_id={member_id} name={member['name']}")
    return dict(member)
