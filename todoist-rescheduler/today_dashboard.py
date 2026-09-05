#!/usr/bin/env python3
"""Today Dashboard — aggregate GitHub issues + Todoist + Google Calendar
into a single HTML page so all of today's work is visible in one screen.

Aggregation dashboard (方式2). Each source remains the master of its own
data; this script only reads and renders them together. Deterministic, LLM-free.

Output:
  --html DIR   -> writes DIR/today_dashboard.html (default below)
  --json       -> print JSON to stdout instead of writing HTML
Timezone: UTC. All timestamps in this dashboard are Zulu-suffixed (e.g. 2300Z).
"""

import argparse
import html
import json
import os
import re
import subprocess
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

LOCAL_ZONE = "UTC"
import project_registry  # single source of truth — replaces scripts/repo_registry.json
TODAY_API = "https://api.todoist.com/api/v1/tasks"


def now_local():
    return datetime.now(ZoneInfo(LOCAL_ZONE))


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


# ---------------- GitHub ----------------
def fetch_github_issues():
    """Pull all open issues across every (project, repo) pair in the registry."""
    registry = project_registry.load()
    issues = []
    errors = []
    for entry, repo in project_registry.iter_repos(registry):
        owner, repo_name = repo["owner"], repo["repo"]
        p = run([
            "gh", "issue", "list", "-R", f"{owner}/{repo_name}",
            "--state", "open", "--limit", "100",
            "--json", "number,title,labels,assignees,url,updatedAt",
        ])
        if p.returncode != 0:
            errors.append(f"{owner}/{repo_name}: {p.stderr.strip()[:80]}")
            continue
        try:
            for it in json.loads(p.stdout):
                issues.append({"repo": f"{owner}/{repo_name}", **it})
        except Exception:
            errors.append(f"{owner}/{repo_name}: parse error")
    return issues, errors


# ---------------- Todoist ----------------
def fetch_todoist(token):
    req = urllib.request.Request(
        TODAY_API,
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    if isinstance(data, dict):
        return data.get("results", [])
    return data


def todoist_view(tasks, today_date, tz):
    view_today, overdue = [], []
    for t in tasks:
        if t.get("is_deleted") or t.get("checked") or t.get("is_completed"):
            continue
        due = t.get("due") or {}
        if not isinstance(due, dict):
            continue
        dt_str = due.get("datetime") or due.get("date")
        if not dt_str:
            continue
        try:
            due_dt = datetime.fromisoformat(dt_str)
            due_date = due_dt.date()
        except ValueError:
            continue
        label = ""
        if due.get("datetime"):
            label = due_dt.astimezone().strftime("%H:%M")
        item = {"content": t.get("content", ""), "project": (t.get("project_name") or ""),
                "label": label, "url": t.get("url") or ""}
        if due_date == today_date:
            view_today.append(item)
        elif due_date < today_date:
            item["due_str"] = dt_str[:10]
            overdue.append(item)
    return view_today, overdue


# ---------------- Calendar ----------------
def fetch_calendar():
    p = run(["gog", "calendar", "events", "--from=now", "--days=1"])
    if p.returncode != 0:
        return [], [f"gog calendar: {p.stderr.strip()}"]
    lines = [l for l in p.stdout.splitlines() if l.strip()]
    return lines, []


# ---------------- Render ----------------
def render_html(gh, tod, tod_overdue, cal, cal_errors, gh_errors, day_str):
    E = html.escape
    def plain(c):
        return re.sub(r"^\s*\[[^]]*\]\([^)]*\)\s*", "", c or "").strip()
    parts = [f"""<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Today — {E(day_str)}</title>
<style>
body{{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1a1a1a;background:#fff}}
h1{{font-size:22px;border-bottom:2px solid #eee;padding-bottom:8px}}
h2{{font-size:16px;margin:22px 0 8px}}
.card{{border:1px solid #e8e8e8;border-radius:8px;padding:12px 14px;margin:8px 0}}
.badge{{display:inline-block;background:#f0f0f0;border-radius:10px;font-size:11px;padding:1px 8px;margin-left:6px;vertical-align:middle}}
.overdue{{background:#fdf2f2;border-color:#f5c6c6}}
.time{{color:#666;font-variant-numeric:tabular-nums}}
li{{margin:6px 0}}
.repo{{color:#6a737d;font-size:12px}}
.err{{color:#c0392b;font-size:12px}}
a{{color:#0366d6;text-decoration:none}}
.section-small{{font-size:13px;color:#666;margin-top:-4px}}
</style></head><body>
<h1>🗓️ Today — {E(day_str)}</h1>"""]

    parts.append("<h2>🕒 スケジュール (Calendar)</h2>")
    if cal:
        parts.append('<div class="card">' +
                     "".join(f"<div>{E(l)}</div>" for l in cal) + "</div>")
    else:
        parts.append('<div class="card">・ 本日のイベントはありません</div>')
    for e in cal_errors:
        parts.append(f'<div class="err">⚠️ {E(e)}</div>')

    parts.append("<h2>✅ タスク (Todoist)</h2>")
    if tod_overdue:
        parts.append('<h3 style="font-size:13px;color:#c0392b">積み残し (Overdue)</h3>')
        parts.append('<div class="card overdue">')
        for t in tod_overdue:
            link = f'<a href="{E(t["url"])}">{E(plain(t["content"]))}</a>' if t["url"] else E(plain(t["content"]))
            parts.append(f'<div>{link} <span class="repo">({E(t["due_str"])})</span></div>')
        parts.append("</div>")
    parts.append('<div class="card">')
    if tod:
        for t in tod:
            tm = f'<span class="default">{E(t["label"])}</span> ' if t["label"] else ""
            link = f'<a href="{E(t["url"])}">{E(plain(t["content"]))}</a>' if t["url"] else E(plain(t["content"]))
            parts.append(f'<div>{tm}{link}'
                         + (f'<span class="badge">{E(t["project"])}</span>' if t["project"] else "")
                         + "</div>")
    else:
        parts.append("・本日のタスクはありません")
    parts.append("</div>")

    parts.append("<h2>🛠️ GitHub Issues (open)</h2>")
    parts.append('<div class="card">')
    if gh:
        by_repo = defaultdict(list)
        for it in gh:
            by_repo[it["repo"]].append(it)
        for repo, its in sorted(by_repo.items()):
            parts.append(f'<div class="repo">◆ {E(repo)}</div>')
            for it in its[:15]:
                labels = "".join(
                    f'<span class="badge" style="background:{E(l.get("color","e8e8e8"))}40;border:1px solid #{E(l.get("color","e8e8e8"))}">{E(l["name"])}</span>'
                    for l in (it.get("labels") or [])
                )
                assignee = ""
                if it.get("assignees"):
                    assignee = f'<span class="repo">← {E(", ".join(a.get("login","") for a in it["assignees"]))}</span>'
                parts.append(f'<div><a href="{E(it["url"])}">#{it["number"]}</a> '
                             f'{E(it["title"])} {labels} {assignee}</div>')
    else:
        parts.append("・openなissueはありません")
    parts.append("</div>")
    for e in gh_errors:
        parts.append(f'<div class="err">⚠️ {E(e)}</div>')

    parts.append('<p class="section-small">Generated by today_dashboard.py · deterministic render</p>')
    parts.append("</body></html>")
    return "".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", metavar="DIR", default=os.path.expanduser("~/today"))
    ap.add_argument("--json", action="store_true")
    args, _ = ap.parse_known_args()

    tz = now_local().tzinfo
    today = now_local().date()

    gh, gh_er = fetch_github_issues()
    gh_errors = list(gh_er)

    token = os.environ.get("TODOIST_API_TOKEN")
    tod, tod_overdue = [], []
    if not token:
        gh_errors.append("TODOIST_API_TOKEN not set")
    else:
        try:
            tod, tod_overdue = todoist_view(fetch_todoist(token), today, tz)
        except Exception as e:
            gh_errors.append(f"Todoist: {e}")

    cal, cal_errors = fetch_calendar()

    if args.json:
        print(json.dumps({
            "date": str(today),
            "github": gh,
            "github_errors": gh_errors,
            "todoist_today": tod,
            "todoist_overdue": tod_overdue,
            "calendar": cal,
            "calendar_errors": cal_errors,
        }, ensure_ascii=False, indent=2))
        return

    os.makedirs(args.html, exist_ok=True)
    out = os.path.join(args.html, "today_dashboard.html")
    with open(out, "w") as f:
        f.write(render_html(gh, tod, tod_overdue, cal, cal_errors, gh_errors, today))
    print(out)


if __name__ == "__main__":
    main()
