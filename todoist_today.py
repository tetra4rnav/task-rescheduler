#!/usr/bin/env python3
"""Todoist 'today' reminder for HEARTBEAT.

Deterministic, LLM-free. Reads TODOIST_API_TOKEN, queries active tasks,
and reports tasks that fall on Matt's local day (Asia/Tokyo), plus overdue.

Output: JSON to stdout:
  {
    "date": "2026-08-06",
    "timezone": "Asia/Tokyo",
    "today":  [ {content, time, project, priority, url} ... ],
    "overdue":[ ... ],
    "count": N
  }
Exits 0 on success (even when empty), non-zero on auth/network errors.
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime

API_BASE = "https://api.todoist.com/api/v1/tasks"
LOCAL_ZONE = "America/New_York"  # EDT/EST (Matt's operational timezone)


def fetch_tasks(token):
    req = urllib.request.Request(API_BASE, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    results = data.get("results", []) if isinstance(data, dict) else data
    return results if isinstance(results, list) else []


from zoneinfo import ZoneInfo


def parse_due(raw_due):
    """Return (local_dt or None, display_string) from a Todoist due object."""
    if not raw_due:
        return None, None
    date_val = raw_due.get("datetime") or raw_due.get("date")
    if not date_val:
        return None, None
    raw_string = raw_due.get("string")
    if "T" in date_val:
        try:
            dt = datetime.fromisoformat(date_val.replace("Z", "+00:00")).astimezone(
                ZoneInfo(LOCAL_ZONE)
            )
            return dt, f"{dt:%H:%M}"
        except ValueError:
            return None, raw_string
    return None, raw_string


def main():
    token = os.environ.get("TODOIST_API_TOKEN")
    if not token:
        print(json.dumps({"error": "TODOIST_API_TOKEN not set"}), file=sys.stderr)
        return 1
    try:
        tasks = fetch_tasks(token)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2

    now = local_now()
    today_str = now.date().isoformat()

    today = []
    overdue = []

    for t in tasks:
        if t.get("is_deleted") or t.get("is_completed") or t.get("checked"):
            continue
        content = (t.get("content") or "").strip()
        if not content:
            continue
        # Strip Markdown link wrapper: "[repo #n](url) title" -> plain title.
        plain = re.sub(r"^\s*\[[^]]*\]\([^)]*\)\s*", "", content).strip()
        item = {
            "content": plain or content,
            "time": "",  # filled below if scheduled today
            "project": t.get("project_name") or "",
            "priority": int(t.get("priority") or 1),
            "url": t.get("url"),
        }
        due_dt, display = parse_due(t.get("due"))
        if due_dt is not None:
            if due_dt.date().isoformat() == today_str:
                item["time"] = display or ""
                today.append(item)
            elif due_dt < now:
                overdue.append(item)
        else:
            date_val = (t.get("due") or {}).get("date")
            if date_val and date_val == today_str:
                today.append(item)

    today.sort(key=lambda x: x["time"] or "ZZZZ")
    overdue.sort(key=lambda x: x["time"] or "ZZZZ")

    out = {
        "date": today_str,
        "timezone": LOCAL_ZONE,
        "today": today,
        "overdue": overdue,
        "count": len(today),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def local_now():
    return datetime.now(ZoneInfo(LOCAL_ZONE))


if __name__ == "__main__":
    sys.exit(main())