#!/usr/bin/env python3
"""前日振り返りレポート生成スクリプト。

Toggl Track の実績記録と、Todoist の前日タスク（予定・完了）を比較し、
時間配分の正確さを評価する。Daily ToDo & Schedule Briefing cron から呼ぶ。

入力: 環境変数 TODOIST_API_TOKEN, ~/.toggl-cli.json
出力: JSON to stdout (structured reflection data)
"""

import json
import os
import sys
import base64
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

LOCAL_TZ = ZoneInfo("America/New_York")  # Matt の運用タイムゾーン (EDT)


def utc_to_local(ts):
    """ISO8601 UTC 文字列を LOCAL_TZ の datetime に変換。失敗時 None。"""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(LOCAL_TZ)
    except Exception:
        return None


def fmt_dur(seconds):
    seconds = int(seconds or 0)
    if seconds <= 0:
        return "0m"
    h, m = divmod(seconds // 60, 60)
    return f"{h}h{m:02d}m" if h else f"{m}m"


# ────────────────────────────────────────────────────────────────
# Toggl Track (v9 / Basic auth)
# ────────────────────────────────────────────────────────────────
def toggl_headers():
    cfg_path = os.path.expanduser("~/.toggl-cli.json")
    with open(cfg_path) as f:
        cfg = json.load(f)
    token = cfg.get("api_token") or os.environ.get("TOGGL_API_TOKEN")
    if not token:
        raise RuntimeError("no toggl api_token")
    b = base64.b64encode(f"{token}:api_token".encode()).decode()
    return {"Authorization": f"Basic {b}"}


def fetch_toggl_recent(limit=1000):
    """パラメータなしで最近の time_entries を取得（<=id まで返る）。"""
    url = "https://api.track.toggl.com/api/v9/me/time_entries"
    req = urllib.request.Request(url, headers=toggl_headers())
    with urllib.request.urlopen(req, timeout=40) as r:
        data = json.loads(r.read().decode("utf-8"))
    entries = data if isinstance(data, list) else []
    return entries[:limit]


def filter_toggl_for_date(entries, day):
    """start を LOCAL_TZ に直して該当日だけ残す。dur 欠落時は start/stop から計算。"""
    out = []
    for e in entries:
        start = utc_to_local(e.get("start"))
        if start is None or start.date() != day:
            continue
        dur_ms = e.get("dur")
        if dur_ms is None and e.get("stop"):
            stop = utc_to_local(e.get("stop"))
            if stop:
                dur_ms = int((stop - start).total_seconds() * 1000)
        if dur_ms is None:
            dur_ms = 0
        dur_ms = dur_ms if dur_ms >= 0 else 0
        out.append({
            "description": e.get("description") or "(no description)",
            "project_id": e.get("project_id") or "",
            "start": e.get("start"),
            "stop": e.get("stop"),
            "start_local": start.isoformat(),
            "duration_seconds": dur_ms / 1000,
        })
    return out


def summarize_toggl(entries):
    """description 単位に集約 + 合計秒数。"""
    summary = {}
    for e in entries:
        key = e["description"]
        if key not in summary:
            summary[key] = {"description": key, "total_seconds": 0, "entries": []}
        summary[key]["total_seconds"] += e["duration_seconds"]
        summary[key]["entries"].append(e)
    return summary


# ────────────────────────────────────────────────────────────────
# Todoist (Unified API v1)
# ────────────────────────────────────────────────────────────────
def todoist_headers():
    token = os.environ.get("TODOIST_API_TOKEN")
    if not token:
        raise RuntimeError("TODOIST_API_TOKEN not set")
    return {"Authorization": f"Bearer {token}"}


def fetch_todoist_tasks():
    req = urllib.request.Request(
        "https://api.todoist.com/api/v1/tasks", headers=todoist_headers()
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode("utf-8"))
    res = data.get("results", []) if isinstance(data, dict) else data
    return res if isinstance(res, list) else []


def fetch_todoist_completed(day):
    """Unified API v1 の completed エンドポイント。"""
    since = datetime.combine(day, datetime.min.time(), tzinfo=LOCAL_TZ).isoformat()
    url = "https://api.todoist.com/api/v1/tasks/completed?limit=200&since=" + urllib.parse.quote(since)
    req = urllib.request.Request(url, headers=todoist_headers())
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode("utf-8"))
    items = data.get("items", []) if isinstance(data, dict) else data
    return items if isinstance(items, list) else []


def due_datetime(raw_due):
    if not raw_due:
        return None
    v = raw_due.get("datetime") or raw_due.get("date")
    if not v:
        return None
    return utc_to_local(v)


def summarize_todoist(day):
    tasks = fetch_todoist_tasks()
    completed = []
    try:
        completed = fetch_todoist_completed(day)
    except Exception as e:
        print(json.dumps({"warning": f"todoist completed: {e}"}), file=sys.stderr)

    scheduled = []
    for t in tasks:
        if t.get("is_deleted") or t.get("is_completed") or t.get("checked"):
            continue
        due = due_datetime(t.get("due"))
        if due and due.date() == day:
            scheduled.append({
                "content": (t.get("content") or "").strip(),
                "due_time": due.strftime("%H:%M"),
                "priority": int(t.get("priority") or 1),
                "project": t.get("project_name") or "",
            })

    done = []
    for c in completed:
        ct = utc_to_local(c.get("completed_at") or c.get("completed_date"))
        if ct and ct.date() == day:
            done.append({
                "content": (c.get("content") or "").strip(),
                "completed_at": ct.strftime("%H:%M"),
                "kind": c.get("type") or "",
            })
    return {"scheduled": scheduled, "completed": done}


# ────────────────────────────────────────────────────────────────
# Reflection
# ────────────────────────────────────────────────────────────────
def build_reflection(toggl_summary, todoist_summary):
    tracked_sec = sum(v["total_seconds"] for v in toggl_summary.values())
    planned = todoist_summary["scheduled"]
    completed = todoist_summary["completed"]

    # 予定タスク名と Toggl 記述の部分一致で「計上された予定」を判定
    planned_lc = [s["content"].lower() for s in planned]
    matched = []
    unmatched = []
    allocated_secs = 0
    for v in toggl_summary.values():
        d = v["description"]
        dl = d.lower()
        hit = any(pc in dl or dl in pc for pc in planned_lc)
        if hit:
            matched.append(d)
            allocated_secs += v["total_seconds"]
        else:
            unmatched.append(d)

    gaps = [s for s in planned
            if not any((s["content"].lower() in m.lower()) or (m.lower() in s["content"].lower())
                       for m in matched)]

    return {
        "total_tracked_hours": round(tracked_sec / 3600, 2),
        "tracked_entries": len(toggl_summary),
        "planned_tasks": len(planned),
        "completed_tasks": len(completed),
        "matched_toggl": matched,
        "unmatched_toggl": unmatched,
        "planned_with_no_toggl": gaps,
    }


def main():
    yesterday = datetime.now(LOCAL_TZ).date() - timedelta(days=1)

    try:
        all_entries = fetch_toggl_recent()
        y_entries = filter_toggl_for_date(all_entries, yesterday)
        toggl_summary = summarize_toggl(y_entries)
        toggl_err = None
    except Exception as e:
        toggl_summary = {}
        toggl_err = str(e)

    todoist_err = None
    todoist_summary = {"scheduled": [], "completed": []}
    try:
        todoist_summary = summarize_todoist(yesterday)
    except Exception as e:
        todoist_err = str(e)

    reflection = build_reflection(toggl_summary, todoist_summary) if not toggl_err else {}

    out = {
        "date": str(yesterday),
        "timezone": str(LOCAL_TZ),
        "toggl_entries": toggl_summary,
        "todoist": todoist_summary,
        "reflection": reflection,
        "errors": {"toggl": toggl_err, "todoist": todoist_err},
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()