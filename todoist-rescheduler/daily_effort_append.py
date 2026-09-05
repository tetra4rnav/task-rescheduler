#!/usr/bin/env python3
"""Append today's deterministic Todoist project effort table to the daily log.

Uses only Todoist tasks already assigned a datetime for today; no task scheduling
or mutation is performed. Re-running replaces the managed block for today.
"""
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

API = "https://api.todoist.com/api/v1"
ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("UTC")
START = "<!-- tetra:daily-effort:start -->"
END = "<!-- tetra:daily-effort:end -->"


def get(path):
    token = os.environ.get("TODOIST_API_TOKEN")
    if not token:
        raise RuntimeError("TODOIST_API_TOKEN is not set")
    req = Request(API + path, headers={"Authorization": f"Bearer {token}"})
    with urlopen(req, timeout=30) as response:
        return json.load(response)


def items(value):
    if isinstance(value, list): return value
    return value.get("results", value.get("items", [])) if isinstance(value, dict) else []


def duration(task):
    d = task.get("duration")
    if isinstance(d, dict):
        return int(d.get("amount") or 0) if d.get("unit") in ("minute", "minutes") else 0
    desc = task.get("description", "")
    m = re.search(r"(?:所要時間|概算)\s*[:：]?\s*(\d+)\s*分", desc)
    return int(m.group(1)) if m else 0


def main():
    now = datetime.now(TZ)
    day = now.date().isoformat()
    tasks = items(get("/tasks"))
    projects = {str(p.get("id")): p.get("name", "No Project") for p in items(get("/projects"))}
    rows = {}
    for task in tasks:
        due = (task.get("due") or {}).get("datetime")
        if not due: continue
        try: local_date = datetime.fromisoformat(due.replace("Z", "+00:00")).astimezone(TZ).date().isoformat()
        except ValueError: continue
        if local_date != day: continue
        project = projects.get(str(task.get("project_id")), "No Project")
        bucket = rows.setdefault(project, {"count": 0, "minutes": 0})
        bucket["count"] += 1; bucket["minutes"] += duration(task)
    lines = [START, f"## Daily Project Effort ({day})", "", "| Project | Tasks | Planned minutes |", "|---|---:|---:|"]
    for project in sorted(rows):
        r = rows[project]; lines.append(f"| {project} | {r['count']} | {r['minutes']} |" )
    if not rows: lines.append("| No scheduled project tasks | 0 | 0 |")
    lines += ["", END]
    path = ROOT / "memory" / f"{day}.md"
    text = path.read_text() if path.exists() else f"# {day}\n\nActivity timezone: UTC\n"
    block = "\n".join(lines)
    pattern = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)
    text = pattern.sub(block, text) if pattern.search(text) else text.rstrip() + "\n\n" + block + "\n"
    path.write_text(text)
    print(json.dumps({"date": day, "projects": len(rows), "tasks": sum(r["count"] for r in rows.values()), "path": str(path)}))


if __name__ == "__main__":
    try: main()
    except Exception as exc:
        print(f"daily effort append failed: {exc}", file=sys.stderr)
        sys.exit(1)
