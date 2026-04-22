from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from pydantic import BaseModel
from database import get_db
from routes.auth import get_current_member
from logger import get_logger, log_db_event, log_gemini_prompt, log_gemini_response, log_extracted, log_section
from typing import Optional
import os, json, re, base64
import google.generativeai as genai

log = get_logger("scans")
router = APIRouter()
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")

# ── Extraction prompt ── (null-safe, no hallucination)
EXTRACTION_PROMPT = """You are a DEXA body composition scan data extractor.

Extract metrics from this DEXA scan PDF. Return ONLY a valid JSON object — no markdown, no explanation.

CRITICAL RULES:
- If a value is not clearly present in the document, use null. NEVER guess or invent values.
- Convert kg to lbs if needed (multiply by 2.20462)
- Body fat % must be a percentage like 24.5, NOT a decimal like 0.245
- If scan date not found, use today's date in YYYY-MM-DD format

Return exactly this JSON structure:
{
  "scan_date": "YYYY-MM-DD",
  "total_body_fat_pct": <number or null>,
  "total_lean_mass_lbs": <number or null>,
  "total_fat_mass_lbs": <number or null>,
  "total_bmc_lbs": <number or null>,
  "total_weight_lbs": <number or null>,
  "android_fat_pct": <number or null>,
  "gynoid_fat_pct": <number or null>,
  "visceral_fat_mass_lbs": <number or null>,
  "visceral_fat_area_cm2": <number or null>,
  "left_arm_lean_lbs": <number or null>,
  "right_arm_lean_lbs": <number or null>,
  "left_leg_lean_lbs": <number or null>,
  "right_leg_lean_lbs": <number or null>,
  "trunk_lean_lbs": <number or null>,
  "lumbar_spine_bmd": <number or null>,
  "femur_neck_bmd": <number or null>,
  "android_gynoid_ratio": <number or null>,
  "resting_metabolic_rate": <number or null>,
  "raw_notes": "<any other notable findings, or empty string>"
}

Return ONLY the JSON object. No markdown fences. No preamble."""

def _gemini_model():
    if not GEMINI_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not set on server.")
    genai.configure(api_key=GEMINI_KEY)
    return genai.GenerativeModel("gemini-2.5-flash")

def _save_scan(conn, member_id: int, extracted: dict) -> dict:
    """Insert a scan record and return it."""
    c = conn.cursor()
    c.execute("""
        INSERT INTO scans (
            member_id, scan_date,
            total_body_fat_pct, total_lean_mass_lbs, total_fat_mass_lbs,
            total_bmc_lbs, total_weight_lbs,
            android_fat_pct, gynoid_fat_pct,
            visceral_fat_mass_lbs, visceral_fat_area_cm2,
            left_arm_lean_lbs, right_arm_lean_lbs,
            left_leg_lean_lbs, right_leg_lean_lbs, trunk_lean_lbs,
            lumbar_spine_bmd, femur_neck_bmd,
            android_gynoid_ratio, resting_metabolic_rate, raw_notes
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        member_id,
        extracted.get("scan_date", ""),
        extracted.get("total_body_fat_pct"),
        extracted.get("total_lean_mass_lbs"),
        extracted.get("total_fat_mass_lbs"),
        extracted.get("total_bmc_lbs"),
        extracted.get("total_weight_lbs"),
        extracted.get("android_fat_pct"),
        extracted.get("gynoid_fat_pct"),
        extracted.get("visceral_fat_mass_lbs"),
        extracted.get("visceral_fat_area_cm2"),
        extracted.get("left_arm_lean_lbs"),
        extracted.get("right_arm_lean_lbs"),
        extracted.get("left_leg_lean_lbs"),
        extracted.get("right_leg_lean_lbs"),
        extracted.get("trunk_lean_lbs"),
        extracted.get("lumbar_spine_bmd"),
        extracted.get("femur_neck_bmd"),
        extracted.get("android_gynoid_ratio"),
        extracted.get("resting_metabolic_rate"),
        extracted.get("raw_notes", ""),
    ))
    scan_id = c.lastrowid
    conn.commit()
    scan = dict(conn.execute("SELECT * FROM scans WHERE id = ?", (scan_id,)).fetchone())
    log_db_event(log, "INSERT", "scans", {
        "id": scan_id, "member_id": member_id,
        "scan_date": extracted.get("scan_date"),
        "body_fat_pct": extracted.get("total_body_fat_pct"),
        "lean_mass_lbs": extracted.get("total_lean_mass_lbs"),
        "weight_lbs": extracted.get("total_weight_lbs"),
    })
    return scan

# ── Routes ──────────────────────────────────────────────────────

@router.get("/scans/me")
def my_scans(request: Request):
    member_id = get_current_member(request)
    conn = get_db()
    scans = conn.execute(
        "SELECT * FROM scans WHERE member_id = ? ORDER BY scan_date ASC", (member_id,)
    ).fetchall()
    conn.close()
    log.info(f"Fetched {len(scans)} scans for member_id={member_id}")
    return [dict(s) for s in scans]

@router.get("/scans/member/{member_id}")
def member_scans(member_id: int):
    conn = get_db()
    scans = conn.execute(
        "SELECT * FROM scans WHERE member_id = ? ORDER BY scan_date ASC", (member_id,)
    ).fetchall()
    conn.close()
    log.info(f"Coach fetched {len(scans)} scans for member_id={member_id}")
    return [dict(s) for s in scans]

@router.get("/members")
def all_members():
    conn = get_db()
    rows = conn.execute("""
        SELECT m.id, m.name, m.email, m.age, m.height_cm, m.goal,
               COUNT(s.id) as scan_count, MAX(s.scan_date) as last_scan
        FROM members m
        LEFT JOIN scans s ON s.member_id = m.id
        GROUP BY m.id ORDER BY m.name
    """).fetchall()
    conn.close()
    result = [dict(r) for r in rows]
    log.info(f"Members list fetched — {len(result)} members")
    return result

@router.get("/members/{member_id}/summary")
def member_summary(member_id: int):
    conn = get_db()
    member = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
    scans  = conn.execute("SELECT * FROM scans WHERE member_id = ? ORDER BY scan_date ASC", (member_id,)).fetchall()
    conn.close()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    return {"member": dict(member), "scans": [dict(s) for s in scans]}

@router.post("/scans/upload")
async def upload_scan(
    request: Request,
    file: UploadFile = File(...),
    scan_date_override: Optional[str] = None
):
    member_id = get_current_member(request)
    log_section(log, f"PDF UPLOAD — member_id={member_id}")
    log.info(f"File: {file.filename} | type: {file.content_type}")

    if not file.filename.lower().endswith(".pdf"):
        log.warning(f"Rejected non-PDF: {file.filename}")
        raise HTTPException(status_code=400, detail="Please upload a PDF file (.pdf extension required)")

    pdf_bytes = await file.read()
    size_kb = len(pdf_bytes) / 1024
    log.info(f"PDF size: {size_kb:.1f} KB")

    if len(pdf_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF too large (max 20 MB)")

    # Validate override date
    if scan_date_override:
        if re.match(r'^\d{4}-\d{2}-\d{2}$', scan_date_override):
            log.info(f"Scan date override: {scan_date_override}")
        else:
            log.warning(f"Invalid date override ignored: {scan_date_override}")
            scan_date_override = None

    log.info("Sending to Gemini for extraction…")
    log_gemini_prompt(log, EXTRACTION_PROMPT, extra=f"(+{size_kb:.0f}KB PDF)")

    extracted = await _extract_with_gemini(pdf_bytes)

    if not extracted:
        log.error("Extraction failed — Gemini returned nothing parseable")
        raise HTTPException(
            status_code=422,
            detail="Could not automatically extract DEXA data from this PDF. "
                   "The format may be unsupported. Please use the manual entry option."
        )

    # Check minimum required fields
    if not extracted.get("scan_date") and not scan_date_override:
        from datetime import date
        extracted["scan_date"] = date.today().isoformat()
        log.warning("No scan date found — defaulting to today")

    all_null = all(
        extracted.get(k) is None
        for k in ["total_body_fat_pct", "total_lean_mass_lbs", "total_weight_lbs"]
    )
    if all_null:
        log.error("All key metrics are null — likely not a DEXA report")
        raise HTTPException(
            status_code=422,
            detail="This PDF does not appear to contain DEXA body composition data. "
                   "Please upload a DEXA scan report, or use manual entry."
        )

    # Apply date override
    if scan_date_override:
        log.info(f"Overriding date '{extracted.get('scan_date')}' → '{scan_date_override}'")
        extracted["scan_date"] = scan_date_override

    log_extracted(log, extracted)

    conn = get_db()
    scan = _save_scan(conn, member_id, extracted)
    conn.close()

    log.info(f"✅ Scan saved — scan_id={scan['id']} member_id={member_id} date={scan['scan_date']}")
    return scan

def _classify_gemini_error(e: Exception) -> str:
    """Return a short user-friendly error message for Gemini failures."""
    msg = str(e)
    if "429" in msg or "quota" in msg.lower() or "rate" in msg.lower():
        retry = re.search(r"retry in ([\d.]+)s", msg)
        wait  = f" Retry in ~{int(float(retry.group(1)))}s." if retry else ""
        log.warning(f"Gemini rate limit hit (scans): {msg[:200]}")
        return f"Rate limit reached — free Gemini API allows 20 requests/day.{wait}"
    if "403" in msg or "api key" in msg.lower():
        log.error(f"Gemini auth error (scans): {msg[:200]}")
        return "API key error — check GEMINI_API_KEY on server."
    if "timeout" in msg.lower():
        log.error(f"Gemini timeout (scans): {msg[:200]}")
        return "Request timed out — PDF may be too large or complex."
    log.error(f"Gemini error ({type(e).__name__}): {msg[:400]}")
    return f"AI extraction failed ({type(e).__name__}) — try manual entry."

async def _extract_with_gemini(pdf_bytes: bytes) -> Optional[dict]:
    try:
        model = _gemini_model()
        b64   = base64.standard_b64encode(pdf_bytes).decode()
        response = model.generate_content([
            {"mime_type": "application/pdf", "data": b64},
            EXTRACTION_PROMPT
        ])
        raw = response.text.strip()
        log_gemini_response(log, raw, label="(PDF extraction)")

        # Strip markdown fences if present
        clean = re.sub(r"^```[a-z]*\n?", "", raw)
        clean = re.sub(r"\n?```$", "", clean).strip()

        parsed = json.loads(clean)
        log.info(f"JSON parsed OK — {len(parsed)} keys")
        return parsed

    except json.JSONDecodeError as e:
        log.error(f"JSON parse error: {e}")
        try: log.error(f"Raw was: {raw[:400]}")
        except: pass
        return None
    except Exception as e:
        friendly = _classify_gemini_error(e)
        # Store friendly message to re-raise as HTTP error
        raise HTTPException(status_code=503, detail=friendly)

# ── Manual scan entry (fallback when PDF extraction fails) ──────

class ManualScanEntry(BaseModel):
    scan_date: str
    total_body_fat_pct:    Optional[float] = None
    total_lean_mass_lbs:   Optional[float] = None
    total_fat_mass_lbs:    Optional[float] = None
    total_weight_lbs:      Optional[float] = None
    visceral_fat_area_cm2: Optional[float] = None
    resting_metabolic_rate:Optional[float] = None
    android_fat_pct:       Optional[float] = None
    gynoid_fat_pct:        Optional[float] = None
    trunk_lean_lbs:        Optional[float] = None
    raw_notes:             Optional[str]   = ""

@router.post("/scans/manual")
async def manual_scan(request: Request, data: ManualScanEntry):
    member_id = get_current_member(request)
    log_section(log, f"MANUAL ENTRY — member_id={member_id}")

    if not data.scan_date or not re.match(r'^\d{4}-\d{2}-\d{2}$', data.scan_date):
        raise HTTPException(status_code=400, detail="Valid scan_date (YYYY-MM-DD) is required")

    extracted = data.model_dump()
    log_extracted(log, extracted)

    conn = get_db()
    scan = _save_scan(conn, member_id, extracted)
    conn.close()

    log.info(f"✅ Manual scan saved — scan_id={scan['id']} date={scan['scan_date']}")
    return scan
