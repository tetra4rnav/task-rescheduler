#!/usr/bin/env python3
"""Append a JSON Lines entry to /opt/data/logs/task-rescheduler.log.

Single source of truth for reschedule execution audit. Called from both
cron payload (Stage 4) and chat-driven payload (Stage 4) after each run.

Usage:
  python3 log_append.py --trigger chat --mode apply --run-id <uuid> --plan-file /path/to/plan.json [--source-thread t:...]
  python3 log_append.py --trigger cron --mode dry-run --run-id <uuid> --plan-file /path/to/plan.json

Plan JSON schema (task-rescheduler v1.x daily-scheduler output):
  {
    "run_id": "...",
    "operations": {"todoist_due_update": [...]},
    "scheduled": [...],
    "unscheduled": [...],
    "deferred": [...],
    "errors": [...],
    "warnings": [...]
  }
"""
import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

LOG_PATH = Path("/opt/data/logs/task-rescheduler.log")
TZ = ZoneInfo("UTC")


def load_plan(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def summarize(plan):
    """Extract compact metrics from a plan JSON. Single source of truth = plan JSON."""
    ops = plan.get("operations", {}).get("todoist_due_update", [])
    scheduled = plan.get("scheduled", [])
    unscheduled = plan.get("unscheduled", [])
    deferred = plan.get("deferred", [])

    past_due_count = 0
    past_due_max_days = 0
    for entry in scheduled + unscheduled:
        breakdown = entry.get("score_breakdown") or {}
        od = breakdown.get("overdue_days") or 0
        if od > 0:
            past_due_count += 1
            past_due_max_days = max(past_due_max_days, od)

    noop_ops = sum(1 for op in ops if op.get("status") == "noop")
    write_ops = len(ops) - noop_ops

    return {
        "scheduled": len(scheduled),
        "unscheduled": len(unscheduled),
        "deferred": len(deferred),
        "todoist_ops": write_ops,
        "todoist_noop": noop_ops,
        "past_due_in_set": past_due_count,
        "past_due_max_days": past_due_max_days,
        "errors": len(plan.get("errors", [])),
        "warnings": len(plan.get("warnings", [])),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--trigger", required=True, choices=["chat", "cron", "manual"])
    parser.add_argument("--mode", required=True, choices=["dry-run", "apply"])
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--plan-file", required=True)
    parser.add_argument("--source-thread", default=None,
                        help="Slack thread id for chat trigger (e.g. 't:1788546438.110359')")
    parser.add_argument("--applied", action="store_true",
                        help="Set when --mode apply actually wrote to Todoist/Calendar")
    parser.add_argument("--notes", default=None,
                        help="Free-text annotation (e.g. user reply 'apply' in chat flow)")
    args = parser.parse_args()

    if not LOG_PATH.parent.exists():
        print(f"ERROR: log directory missing: {LOG_PATH.parent}", file=sys.stderr)
        return 2

    plan = load_plan(args.plan_file)
    summary = summarize(plan)

    entry = {
        "ts": datetime.now(TZ).isoformat(timespec="seconds"),
        "trigger": args.trigger,
        "mode": args.mode,
        "applied": bool(args.applied) or args.mode == "apply",
        "run_id": args.run_id,
        "source_thread": args.source_thread,
        "summary": summary,
        "notes": args.notes,
    }

    # Atomic append: write to temp then rename to avoid interleaving
    tmp = LOG_PATH.with_suffix(".tmp")
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with open(tmp, "a", encoding="utf-8") as f:
        f.write(line)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, LOG_PATH)

    print(json.dumps({"ok": True, "log": str(LOG_PATH), "entry": entry}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
