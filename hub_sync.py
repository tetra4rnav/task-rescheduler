#!/usr/bin/env python3
"""Deterministic Project Hub sync — regenerates Portfolio Overview from project md files.

Reads PROJECT_MAP.md to find hub-enabled projects, extracts weekly_target_hours/blocked/phase/deadline
from each project md frontmatter or header, and regenerates the Portfolio Overview section in
project-hub-master.md.

LLM-free. Safe to run every 30 min.
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
HUB = ROOT / "memory" / "project-hub-master.md"
PROJECT_MAP = ROOT / "PROJECT_MAP.md"
TZ = ZoneInfo("America/New_York")

START = "<!-- hub-portfolio:start -->"
END = "<!-- hub-portfolio:end -->"


def parse_project_map():
    """Extract hub-enabled projects from PROJECT_MAP.md."""
    text = PROJECT_MAP.read_text()
    projects = []
    # Match table rows: | Project ID | Canonical name | Aliases | Type | Lifecycle | Canonical memory | Hub |
    # cols: [0]=empty, [1]=Project ID, [2]=Canonical name, [3]=Aliases, [4]=Type, [5]=Lifecycle, [6]=Canonical memory, [7]=Hub, [8]=empty
    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        cols = [c.strip() for c in line.split("|")]
        if len(cols) < 8:
            continue
        project_id = cols[1].strip("`")
        name = cols[2]
        memory_col = cols[6]
        hub = cols[7].lower()
        
        # Skip header/separator rows
        if project_id.startswith("-") or project_id.startswith("Project"):
            continue
        
        # Extract memory path from markdown link: [`memory/...`](memory/...)
        m = re.search(r"\[.*?\]\((.*?)\)", memory_col)
        memory_path = m.group(1) if m else ""
        
        if hub.startswith("yes") and project_id and memory_path:
            projects.append({
                "channel_id": project_id,
                "name": name,
                "memory_path": memory_path,
            })
    return projects


def extract_frontmatter(md_path):
    """Extract weekly_target_hours, blocked, next_deadline, phase from frontmatter."""
    text = md_path.read_text()
    result = {
        "weekly_target_hours": None,
        "blocked": False,
        "next_deadline": None,
        "phase": "Unknown",
    }
    
    # Match YAML frontmatter
    fm_match = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if fm_match:
        fm = fm_match.group(1)
        m = re.search(r"weekly_target_hours:\s*(\d+)", fm)
        if m:
            result["weekly_target_hours"] = int(m.group(1))
        if re.search(r"blocked:\s*true", fm, re.IGNORECASE):
            result["blocked"] = True
        m = re.search(r"next_deadline:\s*(\d{4}-\d{2}-\d{2})", fm)
        if m:
            try:
                result["next_deadline"] = datetime.strptime(m.group(1), "%Y-%m-%d").date()
            except ValueError:
                pass
        m = re.search(r"phase:\s*(.+)", fm)
        if m:
            phase = m.group(1).strip().strip('"\'')
            if len(phase) > 30:
                phase = phase[:27] + "..."
            result["phase"] = phase
    
    return result


def compute_pressure(weekly_target, blocked, deadline_days):
    """Compute pressure indicator."""
    if blocked or weekly_target == 0:
        return "⚫"
    if deadline_days is not None and deadline_days <= 14:
        return "🔴"
    if weekly_target >= 8:
        return "🔴"
    if deadline_days is not None and deadline_days <= 30:
        return "🟡"
    if weekly_target >= 5:
        return "🟡"
    if weekly_target > 0:
        return "🟢"
    return "⚫"


def main():
    projects = parse_project_map()
    now = datetime.now(TZ)
    
    rows = []
    for proj in projects:
        md_path = ROOT / proj["memory_path"]
        if not md_path.exists():
            continue
        
        fm = extract_frontmatter(md_path)
        deadline = fm["next_deadline"]
        phase = fm["phase"]
        
        deadline_days = None
        deadline_str = "null"
        if deadline:
            deadline_days = (deadline - now.date()).days
            deadline_str = str(deadline_days)
        
        weekly_target = fm["weekly_target_hours"] if fm["weekly_target_hours"] is not None else 0
        blocked = fm["blocked"]
        pressure = compute_pressure(weekly_target, blocked, deadline_days)
        
        rows.append({
            "project_id": proj["channel_id"],
            "name": proj["name"],
            "phase": phase,
            "deadline_days": deadline_str,
            "weekly_target_h": weekly_target,
            "blocked": str(blocked).lower(),
            "pressure": pressure,
        })
    
    # Sort by pressure (🔴 > 🟡 > 🟢 > ⚫), then by deadline_days
    pressure_order = {"🔴": 0, "🟡": 1, "🟢": 2, "⚫": 3}
    rows.sort(key=lambda r: (pressure_order.get(r["pressure"], 4), 
                             int(r["deadline_days"]) if r["deadline_days"] != "null" else 9999))
    
    # Build table
    lines = [
        START,
        "## Portfolio Overview",
        f"<!-- Last updated: {now.isoformat(timespec='seconds')} -->",
        "<!-- machine-parseable priority input -->",
        "| project_id | name | phase | deadline_days | weekly_target_h | blocked | pressure |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(f"| {r['project_id']} | {r['name']} | {r['phase']} | {r['deadline_days']} | {r['weekly_target_h']} | {r['blocked']} | {r['pressure']} |")
    
    total_target = sum(r["weekly_target_h"] for r in rows)
    lines.append(f"<!-- Total weekly target: {total_target}h -->")
    lines.append(END)
    
    # Insert into Hub
    if not HUB.exists():
        print(json.dumps({"error": "Hub file not found"}))
        return 1
    
    hub_text = HUB.read_text()
    block = "\n".join(lines)
    pattern = re.compile(re.escape(START) + r".*?" + re.escape(END), re.DOTALL)
    
    if pattern.search(hub_text):
        hub_text = pattern.sub(block, hub_text)
    else:
        # Insert after "## Metadata" section
        m = re.search(r"(## Metadata.*?)(?=\n## )", hub_text, re.DOTALL)
        if m:
            insert_pos = m.end()
            hub_text = hub_text[:insert_pos] + "\n\n" + block + "\n" + hub_text[insert_pos:]
        else:
            # Fallback: insert at top
            hub_text = block + "\n\n" + hub_text
    
    HUB.write_text(hub_text)
    
    print(json.dumps({
        "ok": True,
        "projects": len(rows),
        "total_target_h": total_target,
        "hub": str(HUB.relative_to(ROOT)),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
