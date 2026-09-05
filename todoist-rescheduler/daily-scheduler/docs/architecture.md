# Daily Scheduler Architecture & Logic

## 1. Task Eligibility & Targets (normalize.js)
Scheduler processes all Todoist tasks unless they match exclusion labels (e.g., `no-auto-schedule`). 
Time attributes (overdue, future, fixed) no longer exempt a task from rescheduling — it will be overwritten and optimized based on capacity unless flagged with `no-auto-schedule`.

## 2. Priority & Scoring Logic (priority.js)
The scheduler decides task order using a scoring algorithm based on Todoist priorities, deadline proximity, and task attributes.

### Base Weights (constants.js)
- **Todoist Priority:**
  - P4 (Todoist Priority 1 - Flag Red): 300 points
  - P3 (Todoist Priority 2 - Flag Orange): 200 points
  - P2 (Todoist Priority 3 - Flag Blue): 100 points
  - P1 (Todoist Priority 4 - Flag White): 0 points
  *Explicitly spaced so a lower Todoist priority task won't artificially jump ahead of higher ones just because it has a description or explicit duration.*

- **Deadlines & Overdue:**
  - **Overdue:** Base 400 points + 50 points per day overdue
  - **Same Day (Due Today):** 350 points
  - **Next Day (Due Tomorrow):** 250 points
  - **Soon (Due within 2-4 days):** 100 points
  *A strict overdue and deadline urgency block ensures imminent tasks are scheduled first.*

- **Bonuses & Penalties:**
  - **Explicit Duration Bonus:** +12 points (e.g. `[30m]` exists in title)
  - **Description Bonus:** +15 points
  - **Age Weight:** +2 points per day since creation (max 20 points)
  - **Context Switch Penalty:** -8 points (if project differs from previously scheduled task)
  - **Long Task Penalty:** -5 points per 30 minutes over 60 minutes.

### Tie-Breakers
If scores are identical, the scheduler resolves ties in this order:
1. Score (highest first)
2. Deadline Timestamp (earliest first)
3. Todoist Priority (P4 > P3 > P2 > P1)
4. Creation Age (oldest first)
5. Task ID fallback

## 3. Capacity & Availability (availability.js)
- **Hard Constraints:** Calendar events (Google Calendar) natively block capacity. Work hours (9 AM - 6 PM) limit absolute windows. Maximum daily threshold limits total sum of work.
- **Todoist Decoupling:** Pre-existing Todoist tasks, whether scheduled by task-rescheduler or manually in the future, *do not* limit capacity during the planning phase. Availability is purely Calendar + Base Logic, preventing false 'no-slot-available' errors.
