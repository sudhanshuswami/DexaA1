"""
Kalos Logger — central logging for all modules.
Logs to both console (colored) and kalos.log file.
Toggle verbose mode via LOG_VERBOSE=true env var.
"""

import os
import sys
import json
import logging
from datetime import datetime
from pathlib import Path

# ── Config ──
LOG_VERBOSE = os.getenv("LOG_VERBOSE", "true").lower() == "true"
LOG_TO_FILE = os.getenv("LOG_TO_FILE", "true").lower() == "true"
LOG_FILE    = os.getenv("LOG_FILE", "kalos.log")

# ── ANSI Colors ──
class C:
    RESET  = "\033[0m"
    BOLD   = "\033[1m"
    DIM    = "\033[2m"
    # colors
    GREEN  = "\033[92m"
    YELLOW = "\033[93m"
    RED    = "\033[91m"
    CYAN   = "\033[96m"
    BLUE   = "\033[94m"
    MAGENTA= "\033[95m"
    WHITE  = "\033[97m"
    GRAY   = "\033[90m"

# Windows console fix
if sys.platform == "win32":
    os.system("color")  # enables ANSI on Windows CMD

# ── Formatter ──
class ColorFormatter(logging.Formatter):
    LEVEL_COLORS = {
        "DEBUG":    C.GRAY,
        "INFO":     C.GREEN,
        "WARNING":  C.YELLOW,
        "ERROR":    C.RED,
        "CRITICAL": C.RED + C.BOLD,
    }
    def format(self, record):
        color = self.LEVEL_COLORS.get(record.levelname, C.RESET)
        ts    = datetime.now().strftime("%H:%M:%S")
        level = f"{color}{record.levelname:<8}{C.RESET}"
        name  = f"{C.GRAY}[{record.name}]{C.RESET}"
        msg   = record.getMessage()
        return f"{C.DIM}{ts}{C.RESET} {level} {name} {msg}"

class PlainFormatter(logging.Formatter):
    def format(self, record):
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return f"{ts} [{record.levelname}] [{record.name}] {record.getMessage()}"

# ── Root setup ──
def _setup():
    root = logging.getLogger("kalos")
    root.setLevel(logging.DEBUG if LOG_VERBOSE else logging.INFO)
    root.handlers.clear()

    # Console handler (colored)
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(ColorFormatter())
    ch.setLevel(logging.DEBUG if LOG_VERBOSE else logging.INFO)
    root.addHandler(ch)

    # File handler (plain)
    if LOG_TO_FILE:
        fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
        fh.setFormatter(PlainFormatter())
        fh.setLevel(logging.DEBUG)
        root.addHandler(fh)

    return root

_root = _setup()

def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"kalos.{name}")

# ── Pretty helpers ──
def _pretty_json(data: dict | list) -> str:
    try:
        return json.dumps(data, indent=2, default=str)
    except Exception:
        return str(data)

def _separator(char="─", width=60, color=C.GRAY):
    return f"{color}{char * width}{C.RESET}"

# ── Section loggers (call these from other modules) ──

def log_section(log: logging.Logger, title: str):
    log.info(f"\n{_separator()}\n{C.BOLD}{C.CYAN}  {title}{C.RESET}\n{_separator()}")

def log_db_event(log: logging.Logger, action: str, table: str, data: dict):
    """Log a database insert/update event."""
    log.info(
        f"{C.MAGENTA}[DB {action}]{C.RESET} table={C.BOLD}{table}{C.RESET}\n"
        f"  {C.DIM}{_pretty_json(data)}{C.RESET}"
    )

def log_gemini_prompt(log: logging.Logger, prompt: str, extra: str = ""):
    """Log the full prompt sent to Gemini."""
    if not LOG_VERBOSE:
        log.info(f"{C.BLUE}[GEMINI PROMPT]{C.RESET} {len(prompt)} chars sent {extra}")
        return
    log.debug(
        f"{C.BLUE}[GEMINI PROMPT]{C.RESET} {extra}\n"
        f"{_separator('·', 50, C.BLUE)}\n"
        f"{C.DIM}{prompt[:3000]}{'...(truncated)' if len(prompt)>3000 else ''}{C.RESET}\n"
        f"{_separator('·', 50, C.BLUE)}"
    )

def log_gemini_response(log: logging.Logger, response: str, label: str = ""):
    """Log raw Gemini response."""
    if not LOG_VERBOSE:
        log.info(f"{C.BLUE}[GEMINI RESPONSE]{C.RESET} {len(response)} chars received {label}")
        return
    log.debug(
        f"{C.BLUE}[GEMINI RESPONSE]{C.RESET} {label}\n"
        f"{_separator('·', 50, C.BLUE)}\n"
        f"{C.DIM}{response[:2000]}{'...(truncated)' if len(response)>2000 else ''}{C.RESET}\n"
        f"{_separator('·', 50, C.BLUE)}"
    )

def log_extracted(log: logging.Logger, data: dict):
    """Log parsed extraction result with null-field warnings."""
    nulls = [k for k, v in data.items() if v is None]
    filled = {k: v for k, v in data.items() if v is not None}
    log.info(
        f"{C.GREEN}[EXTRACTED]{C.RESET} {len(filled)} fields parsed, "
        f"{C.YELLOW}{len(nulls)} nulls{C.RESET}"
    )
    if LOG_VERBOSE:
        log.debug(f"  Parsed data:\n{C.DIM}{_pretty_json(filled)}{C.RESET}")
    if nulls:
        log.warning(f"  Null fields: {C.YELLOW}{', '.join(nulls)}{C.RESET}")

def log_context_summary(log: logging.Logger, members: list, total_scans: int):
    """Log DB context being sent to MemberGPT."""
    log.info(
        f"{C.CYAN}[CONTEXT]{C.RESET} Sending {C.BOLD}{len(members)} members{C.RESET}, "
        f"{C.BOLD}{total_scans} scans{C.RESET} to Gemini"
    )
    if LOG_VERBOSE:
        for m in members:
            log.debug(f"  → {m['name']} ({m.get('scan_count',0)} scans)")
