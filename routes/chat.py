from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from database import get_db
from logger import get_logger, log_gemini_prompt, log_gemini_response, log_context_summary, log_section
from typing import Optional
import os
import google.generativeai as genai

log = get_logger("chat")
router = APIRouter()
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
    history: list[dict] = []
    member_ids: Optional[list[int]] = None  # None = all members

def _build_context(member_ids: Optional[list[int]] = None) -> tuple[str, list, int]:
    """
    Build context string from DB.
    If member_ids is provided, only include those members (saves tokens).
    Returns (context_str, members_list, total_scans)
    """
    conn = get_db()

    if member_ids:
        placeholders = ','.join('?' * len(member_ids))
        members = conn.execute(f"""
            SELECT m.id, m.name, m.email, m.age, m.height_cm, m.goal,
                   COUNT(s.id) as scan_count
            FROM members m
            LEFT JOIN scans s ON s.member_id = m.id
            WHERE m.id IN ({placeholders})
            GROUP BY m.id
        """, member_ids).fetchall()
    else:
        members = conn.execute("""
            SELECT m.id, m.name, m.email, m.age, m.height_cm, m.goal,
                   COUNT(s.id) as scan_count
            FROM members m
            LEFT JOIN scans s ON s.member_id = m.id
            GROUP BY m.id
        """).fetchall()

    total_scans = 0
    ctx_parts = []

    for m in members:
        scans = conn.execute("""
            SELECT scan_date, total_body_fat_pct, total_lean_mass_lbs, total_fat_mass_lbs,
                   total_weight_lbs, android_fat_pct, gynoid_fat_pct,
                   visceral_fat_mass_lbs, visceral_fat_area_cm2,
                   left_arm_lean_lbs, right_arm_lean_lbs, left_leg_lean_lbs, right_leg_lean_lbs,
                   trunk_lean_lbs, lumbar_spine_bmd, femur_neck_bmd,
                   android_gynoid_ratio, resting_metabolic_rate
            FROM scans WHERE member_id = ? ORDER BY scan_date ASC
        """, (m["id"],)).fetchall()

        total_scans += len(scans)

        scan_lines = []
        for s in scans:
            parts = [f"  Date: {s['scan_date']}"]
            if s['total_body_fat_pct']    is not None: parts.append(f"    Body Fat: {s['total_body_fat_pct']}%")
            if s['total_lean_mass_lbs']   is not None: parts.append(f"    Lean Mass: {s['total_lean_mass_lbs']} lbs")
            if s['total_fat_mass_lbs']    is not None: parts.append(f"    Fat Mass: {s['total_fat_mass_lbs']} lbs")
            if s['total_weight_lbs']      is not None: parts.append(f"    Total Weight: {s['total_weight_lbs']} lbs")
            if s['android_fat_pct']       is not None: parts.append(f"    Android Fat: {s['android_fat_pct']}%, Gynoid Fat: {s['gynoid_fat_pct']}%")
            if s['visceral_fat_area_cm2'] is not None: parts.append(f"    Visceral Fat Area: {s['visceral_fat_area_cm2']} cm²")
            if s['resting_metabolic_rate']is not None: parts.append(f"    RMR: {s['resting_metabolic_rate']} kcal/day")
            if s['android_gynoid_ratio']  is not None: parts.append(f"    A/G Ratio: {s['android_gynoid_ratio']}")
            scan_lines.append("\n".join(parts))

        scans_text = "\n".join(scan_lines) if scan_lines else "  No scans recorded."
        ctx_parts.append(
            f"Member: {m['name']} (ID: {m['id']})\n"
            f"  Age: {m['age']}, Height: {m['height_cm']} cm\n"
            f"  Goal: {m['goal']}\n"
            f"  Total scans: {m['scan_count']}\n"
            f"  Scan history:\n{scans_text}"
        )

    conn.close()
    return "\n\n".join(ctx_parts), [dict(m) for m in members], total_scans

SYSTEM_PROMPT = """You are MemberGPT, an expert health coach AI assistant for Kalos — a body composition tracking service.

You have access to DEXA scan data for the members listed below. Answer questions grounded entirely in this data.

STRICT RULES:
1. Base ALL answers on the actual data provided. NEVER hallucinate or invent numbers.
2. If a question cannot be answered from the data provided, say exactly: "I don't have enough data to answer that."
3. Be concise but insightful — coaches are busy professionals.
4. When discussing trends, always state the actual calculated change (e.g. "lost 3.2 lbs of fat, gained 4.4 lbs lean mass").
5. When making coaching recommendations, cite the specific data points that support them.
6. Format responses clearly — use bullet points or sections for multi-part answers.
7. If asked about members not in the data below, say you only have data for the listed members.

Key metric reference:
- Body Fat %: Healthy ~10-20% male, ~18-28% female; higher = more fat mass
- Lean Mass: Muscle + bone + water; increasing = positive
- Visceral Fat Area: <100 cm² low risk, 100-160 moderate, >160 high risk
- A/G Ratio: >1.0 = more abdominal fat pattern (higher cardiovascular risk)
- RMR: Calories burned at rest; higher lean mass = higher RMR

Member data for this session:
{context}"""

@router.post("/chat")
async def chat(req: ChatRequest):
    if not GEMINI_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured on server.")

    log_section(log, f"MEMBERGPT — session={req.session_id}")
    log.info(f"User: {req.message}")
    log.info(f"History: {len(req.history)} msgs | Member filter: {req.member_ids or 'ALL'}")

    context, members, total_scans = _build_context(req.member_ids)
    log_context_summary(log, members, total_scans)

    system = SYSTEM_PROMPT.format(context=context)
    log_gemini_prompt(log, system, extra=f"({len(members)} members, {total_scans} scans)")

    genai.configure(api_key=GEMINI_KEY)
    model = genai.GenerativeModel(
        "gemini-2.5-flash",
        system_instruction=system
    )

    # Build Gemini history
    history = []
    for msg in req.history:
        role = "user" if msg["role"] == "user" else "model"
        history.append({"role": role, "parts": [msg["content"]]})

    chat_session = model.start_chat(history=history)
    full_response = []

    def generate():
        try:
            response = chat_session.send_message(req.message, stream=True)
            for chunk in response:
                if chunk.text:
                    full_response.append(chunk.text)
                    yield chunk.text
            assembled = "".join(full_response)
            log_gemini_response(log, assembled, label=f"session={req.session_id}")
            log.info(f"Response: {len(assembled)} chars streamed")
        except Exception as e:
            log.error(f"Gemini streaming error: {type(e).__name__}: {e}")
            yield f"\n\n[Error communicating with AI: {str(e)}]"

    return StreamingResponse(generate(), media_type="text/plain")
