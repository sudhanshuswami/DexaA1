import sqlite3
import hashlib
import os
from datetime import datetime, timedelta
from logger import get_logger, log_db_event, log_section

log = get_logger("database")
DB_PATH = os.environ.get("DB_PATH", "kalos.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def init_db():
    log.info(f"Initializing database at: {DB_PATH}")
    conn = get_db()
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            name TEXT NOT NULL,
            age INTEGER,
            height_cm REAL,
            goal TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            member_id INTEGER NOT NULL,
            scan_date TEXT NOT NULL,
            total_body_fat_pct REAL,
            total_lean_mass_lbs REAL,
            total_fat_mass_lbs REAL,
            total_bmc_lbs REAL,
            total_weight_lbs REAL,
            android_fat_pct REAL,
            gynoid_fat_pct REAL,
            visceral_fat_mass_lbs REAL,
            visceral_fat_area_cm2 REAL,
            left_arm_lean_lbs REAL,
            right_arm_lean_lbs REAL,
            left_leg_lean_lbs REAL,
            right_leg_lean_lbs REAL,
            trunk_lean_lbs REAL,
            lumbar_spine_bmd REAL,
            femur_neck_bmd REAL,
            android_gynoid_ratio REAL,
            resting_metabolic_rate REAL,
            raw_notes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (member_id) REFERENCES members(id)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS coach_chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)

    conn.commit()
    log.info("Tables created / verified OK")
    _seed(conn)
    conn.close()
    _log_counts()

def _log_counts():
    conn = get_db()
    members = conn.execute("SELECT COUNT(*) FROM members").fetchone()[0]
    scans   = conn.execute("SELECT COUNT(*) FROM scans").fetchone()[0]
    conn.close()
    log.info(f"Database state → members={members}, scans={scans}")

def _seed(conn):
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM members")
    if c.fetchone()[0] > 0:
        log.info("Seed skipped — data already exists")
        return

    log_section(log, "SEEDING DATABASE")

    members = [
        ("sarah@kalos.com",  "demo123", "Sarah Chen",    29, 165.0, "Lose body fat, maintain muscle"),
        ("jordan@kalos.com", "demo123", "Jordan Rivera", 34, 178.0, "Build lean muscle mass"),
        ("alex@kalos.com",   "demo123", "Alex Thompson", 41, 172.0, "Improve overall body composition"),
        ("maya@kalos.com",   "demo123", "Maya Patel",    26, 160.0, "Athletic performance & fat loss"),
        ("chris@kalos.com",  "demo123", "Chris Morgan",  38, 182.0, "Long-term health & longevity"),
    ]

    member_ids = []
    for email, pw, name, age, height, goal in members:
        c.execute(
            "INSERT INTO members (email, password_hash, name, age, height_cm, goal) VALUES (?,?,?,?,?,?)",
            (email, hash_password(pw), name, age, height, goal)
        )
        mid = c.lastrowid
        member_ids.append(mid)
        log_db_event(log, "INSERT", "members", {"id": mid, "name": name, "email": email, "goal": goal})

    today = datetime.now()
    def d(days_ago):
        return (today - timedelta(days=days_ago)).strftime("%Y-%m-%d")

    all_scans = [
        (member_ids[0], d(10),  32.4, 97.2,  46.8, 4.1, 148.1, 38.2, 35.6, 2.1, 98.4,  9.8,  10.1, 24.3, 25.1, 43.7, 1.12, 0.98, 1.07, 1542),
        (member_ids[1], d(90),  24.1, 138.2, 43.8, 5.2, 187.2, 27.3, 26.1, 1.8, 84.2,  14.2, 14.8, 38.1, 39.2, 58.3, 1.24, 1.11, 1.04, 1987),
        (member_ids[1], d(5),   21.8, 142.6, 40.3, 5.3, 188.2, 24.1, 24.8, 1.5, 74.6,  15.1, 15.6, 39.8, 40.9, 59.4, 1.26, 1.13, 0.97, 2041),
        (member_ids[2], d(270), 28.6, 128.4, 51.2, 4.8, 184.4, 33.1, 30.2, 2.4, 112.3, 13.1, 13.4, 33.2, 34.1, 54.8, 1.18, 1.04, 1.09, 1821),
        (member_ids[2], d(150), 26.9, 130.2, 48.1, 4.9, 183.2, 30.8, 28.9, 2.1, 98.7,  13.6, 13.9, 34.1, 35.2, 55.7, 1.20, 1.05, 1.06, 1848),
        (member_ids[2], d(14),  24.2, 133.8, 43.2, 4.9, 181.9, 27.4, 26.3, 1.7, 81.4,  14.2, 14.6, 35.8, 36.9, 57.4, 1.21, 1.07, 1.04, 1893),
        (member_ids[3], d(360), 36.8, 88.1,  51.7, 3.6, 143.4, 42.1, 38.9, 2.8, 131.2, 8.9,  9.1,  22.1, 22.8, 39.4, 1.08, 0.94, 1.08, 1421),
        (member_ids[3], d(270), 34.2, 90.4,  47.2, 3.7, 141.3, 39.4, 36.8, 2.4, 114.6, 9.2,  9.5,  23.1, 23.9, 40.8, 1.10, 0.96, 1.07, 1453),
        (member_ids[3], d(180), 31.4, 93.2,  43.1, 3.7, 140.0, 36.2, 34.1, 2.0, 96.3,  9.7,  10.0, 24.2, 25.0, 42.4, 1.11, 0.97, 1.06, 1489),
        (member_ids[3], d(90),  28.6, 96.8,  39.0, 3.8, 139.6, 32.8, 31.2, 1.7, 80.1,  10.2, 10.5, 25.4, 26.2, 44.1, 1.12, 0.99, 1.05, 1528),
        (member_ids[3], d(7),   25.3, 100.9, 34.2, 3.8, 138.9, 29.1, 28.3, 1.3, 62.4,  10.8, 11.1, 26.8, 27.6, 45.9, 1.14, 1.01, 1.02, 1574),
        (member_ids[4], d(300), 22.4, 158.3, 45.8, 6.1, 210.2, 26.2, 24.8, 1.9, 89.3,  16.8, 17.2, 42.1, 43.4, 67.2, 1.31, 1.18, 1.05, 2198),
        (member_ids[4], d(210), 23.1, 157.4, 47.2, 6.1, 210.7, 27.1, 25.3, 2.1, 98.4,  16.6, 17.0, 41.8, 43.1, 66.9, 1.30, 1.17, 1.07, 2184),
        (member_ids[4], d(120), 21.8, 159.6, 44.8, 6.2, 210.6, 25.4, 24.2, 1.8, 84.1,  17.0, 17.4, 42.4, 43.8, 67.6, 1.32, 1.19, 1.04, 2211),
        (member_ids[4], d(20),  20.9, 161.2, 42.8, 6.2, 210.2, 24.1, 23.4, 1.6, 74.8,  17.3, 17.8, 43.1, 44.4, 68.4, 1.33, 1.20, 1.03, 2239),
    ]

    for row in all_scans:
        c.execute("""INSERT INTO scans (
            member_id, scan_date,
            total_body_fat_pct, total_lean_mass_lbs, total_fat_mass_lbs, total_bmc_lbs, total_weight_lbs,
            android_fat_pct, gynoid_fat_pct, visceral_fat_mass_lbs, visceral_fat_area_cm2,
            left_arm_lean_lbs, right_arm_lean_lbs, left_leg_lean_lbs, right_leg_lean_lbs, trunk_lean_lbs,
            lumbar_spine_bmd, femur_neck_bmd, android_gynoid_ratio, resting_metabolic_rate)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", row)
        sid = c.lastrowid
        log_db_event(log, "INSERT", "scans", {
            "id": sid, "member_id": row[0], "scan_date": row[1],
            "body_fat_pct": row[2], "lean_mass_lbs": row[3], "weight_lbs": row[6]
        })

    conn.commit()
    log.info(f"Seeded {len(members)} members and {len(all_scans)} scans successfully")
