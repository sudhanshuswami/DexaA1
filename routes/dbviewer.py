from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from database import get_db
from logger import get_logger, log_db_event
from datetime import date
from typing import Optional

log = get_logger("dbviewer")
router = APIRouter()

# ── Validators ──
SCAN_RULES = {
    "scan_date":             {"type": "date"},
    "total_body_fat_pct":    {"type": "float", "min": 1,   "max": 70,   "label": "Body Fat %"},
    "total_lean_mass_lbs":   {"type": "float", "min": 10,  "max": 300,  "label": "Lean Mass (lbs)"},
    "total_fat_mass_lbs":    {"type": "float", "min": 1,   "max": 400,  "label": "Fat Mass (lbs)"},
    "total_weight_lbs":      {"type": "float", "min": 50,  "max": 700,  "label": "Weight (lbs)"},
    "android_fat_pct":       {"type": "float", "min": 1,   "max": 80,   "label": "Android Fat %"},
    "gynoid_fat_pct":        {"type": "float", "min": 1,   "max": 80,   "label": "Gynoid Fat %"},
    "visceral_fat_area_cm2": {"type": "float", "min": 0,   "max": 500,  "label": "Visceral Fat Area"},
    "resting_metabolic_rate":{"type": "float", "min": 500, "max": 5000, "label": "RMR (kcal)"},
    "total_bmc_lbs":         {"type": "float", "min": 1,   "max": 20,   "label": "BMC (lbs)"},
    "visceral_fat_mass_lbs": {"type": "float", "min": 0,   "max": 30,   "label": "Visceral Fat Mass"},
    "left_arm_lean_lbs":     {"type": "float", "min": 1,   "max": 50,   "label": "Left Arm Lean"},
    "right_arm_lean_lbs":    {"type": "float", "min": 1,   "max": 50,   "label": "Right Arm Lean"},
    "left_leg_lean_lbs":     {"type": "float", "min": 5,   "max": 100,  "label": "Left Leg Lean"},
    "right_leg_lean_lbs":    {"type": "float", "min": 5,   "max": 100,  "label": "Right Leg Lean"},
    "trunk_lean_lbs":        {"type": "float", "min": 10,  "max": 150,  "label": "Trunk Lean"},
    "lumbar_spine_bmd":      {"type": "float", "min": 0.5, "max": 2.0,  "label": "Lumbar BMD"},
    "femur_neck_bmd":        {"type": "float", "min": 0.4, "max": 2.0,  "label": "Femur BMD"},
    "android_gynoid_ratio":  {"type": "float", "min": 0.5, "max": 2.0,  "label": "A/G Ratio"},
}

MEMBER_RULES = {
    "name": {"type": "str", "min_len": 2, "max_len": 80,  "label": "Name"},
    "goal": {"type": "str", "min_len": 0, "max_len": 200, "label": "Goal"},
    "age":  {"type": "int", "min": 10,    "max": 110,     "label": "Age"},
}

def _validate_scan_field(field: str, value) -> str | None:
    """Returns error string or None if OK."""
    rule = SCAN_RULES.get(field)
    if not rule:
        return f"Field '{field}' is not editable"
    if value is None or value == "":
        return None  # null allowed
    if rule["type"] == "date":
        try:
            d = date.fromisoformat(str(value))
            if d > date.today():
                return "Scan date cannot be in the future"
        except ValueError:
            return "Invalid date format (use YYYY-MM-DD)"
    elif rule["type"] == "float":
        try:
            v = float(value)
            if v < rule["min"] or v > rule["max"]:
                return f"{rule['label']} must be between {rule['min']} and {rule['max']}"
        except (ValueError, TypeError):
            return f"{rule['label']} must be a number"
    return None

def _validate_member_field(field: str, value) -> str | None:
    rule = MEMBER_RULES.get(field)
    if not rule:
        return f"Field '{field}' is not editable"
    if rule["type"] == "str":
        s = str(value or "")
        if len(s) < rule["min_len"]:
            return f"{rule['label']} is too short"
        if len(s) > rule["max_len"]:
            return f"{rule['label']} is too long (max {rule['max_len']} chars)"
    elif rule["type"] == "int":
        try:
            v = int(value)
            if v < rule["min"] or v > rule["max"]:
                return f"{rule['label']} must be between {rule['min']} and {rule['max']}"
        except (ValueError, TypeError):
            return f"{rule['label']} must be a whole number"
    return None

# ── Models ──
class ScanEdit(BaseModel):
    field: str
    value: Optional[str | float | int] = None

class MemberEdit(BaseModel):
    field: str
    value: Optional[str | float | int] = None

# ── Routes ──
@router.get("/dbviewer/data")
def db_data():
    conn = get_db()
    members = [dict(r) for r in conn.execute("""
        SELECT m.*, COUNT(s.id) as scan_count, MAX(s.scan_date) as last_scan
        FROM members m LEFT JOIN scans s ON s.member_id = m.id
        GROUP BY m.id ORDER BY m.id
    """).fetchall()]

    scans = [dict(r) for r in conn.execute("""
        SELECT s.*, m.name as member_name
        FROM scans s JOIN members m ON m.id = s.member_id
        ORDER BY s.id DESC LIMIT 100
    """).fetchall()]

    stats = {
        "total_members": conn.execute("SELECT COUNT(*) FROM members").fetchone()[0],
        "total_scans":   conn.execute("SELECT COUNT(*) FROM scans").fetchone()[0],
        "latest_scan":   conn.execute("SELECT MAX(created_at) FROM scans").fetchone()[0],
        "latest_member": conn.execute("SELECT MAX(created_at) FROM members").fetchone()[0],
    }
    conn.close()
    return {"stats": stats, "members": members, "scans": scans}

@router.get("/dbviewer/rules")
def get_rules():
    """Return validation rules to the frontend."""
    return {"scan_rules": SCAN_RULES, "member_rules": MEMBER_RULES}

@router.patch("/dbviewer/scan/{scan_id}")
def edit_scan(scan_id: int, body: ScanEdit):
    err = _validate_scan_field(body.field, body.value)
    if err:
        raise HTTPException(status_code=422, detail=err)

    # Type-cast value
    rule = SCAN_RULES.get(body.field, {})
    val = body.value
    if val not in (None, ""):
        if rule.get("type") == "float":
            val = round(float(val), 4)
        elif rule.get("type") == "date":
            val = str(val)

    conn = get_db()
    existing = conn.execute("SELECT id FROM scans WHERE id = ?", (scan_id,)).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(status_code=404, detail="Scan not found")

    conn.execute(f"UPDATE scans SET {body.field} = ? WHERE id = ?", (val, scan_id))
    conn.commit()
    updated = dict(conn.execute(
        "SELECT s.*, m.name as member_name FROM scans s JOIN members m ON m.id=s.member_id WHERE s.id=?",
        (scan_id,)
    ).fetchone())
    conn.close()

    log_db_event(log, "UPDATE", "scans", {"id": scan_id, "field": body.field, "new_value": val})
    return updated

@router.patch("/dbviewer/member/{member_id}")
def edit_member(member_id: int, body: MemberEdit):
    err = _validate_member_field(body.field, body.value)
    if err:
        raise HTTPException(status_code=422, detail=err)

    val = body.value
    rule = MEMBER_RULES.get(body.field, {})
    if val is not None and rule.get("type") == "int":
        val = int(val)

    conn = get_db()
    existing = conn.execute("SELECT id FROM members WHERE id = ?", (member_id,)).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(status_code=404, detail="Member not found")

    conn.execute(f"UPDATE members SET {body.field} = ? WHERE id = ?", (val, member_id))
    conn.commit()
    updated = dict(conn.execute(
        "SELECT m.*, COUNT(s.id) as scan_count FROM members m LEFT JOIN scans s ON s.member_id=m.id WHERE m.id=? GROUP BY m.id",
        (member_id,)
    ).fetchone())
    conn.close()

    log_db_event(log, "UPDATE", "members", {"id": member_id, "field": body.field, "new_value": val})
    return updated

@router.delete("/dbviewer/scan/{scan_id}")
def delete_scan(scan_id: int):
    conn = get_db()
    existing = conn.execute("SELECT id, member_id FROM scans WHERE id = ?", (scan_id,)).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(status_code=404, detail="Scan not found")
    conn.execute("DELETE FROM scans WHERE id = ?", (scan_id,))
    conn.commit()
    conn.close()
    log.warning(f"Scan DELETED — scan_id={scan_id}")
    return {"ok": True, "deleted_id": scan_id}
