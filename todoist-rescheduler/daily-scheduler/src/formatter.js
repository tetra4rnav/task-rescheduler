import { parseWindow } from './util.js';

export function formatReport(plan) {
  const isApply = plan.mode === 'apply';
  const modeHeader = isApply ? '✅ APPLIED PLAN' : '🔍 DRY-RUN PREVIEW';
  
  let report = `# Scheduler Report - ${modeHeader}\n`;
  report += `\n**Run ID:** \`${plan.run_id}\``;
  report += `\n**Date:** ${plan.state?.window?.start || 'Unknown'} (${plan.state?.window?.days || 0} day(s))`;
  report += `\n**Timezone:** ${plan.state?.timezone || 'Unknown'}`;
  report += `\n**Plan Hash:** \`${plan.state_hash || 'N/A'}\``;
  
  if (plan.errors?.length > 0) {
    report += `\n\n## ❌ Errors (${plan.errors.length})\n`;
    for (const err of plan.errors) {
      report += `- **${err.code || 'ERROR'}**: ${err.message}\n`;
    }
  }

  if (plan.warnings?.length > 0) {
    report += `\n\n## ⚠️ Warnings (${plan.warnings.length})\n`;
    for (const warn of plan.warnings) {
      report += `- **${warn.code}**: ${warn.message} (Count: ${warn.count || 1})\n`;
    }
  }

  const escalated = (plan.unscheduled || []).filter(item => item.escalation);
  if (escalated.length > 0) {
    report += `\n\n## 🚨 Escalated / High Score Unscheduled (${escalated.length})\n`;
    for (const item of escalated) {
      report += `- [**${item.score}**] [${item.title}](https://todoist.com/app/task/${item.task_id})\n`;
    }
  }

  report += `\n\n## 📅 Scheduled (${plan.scheduled?.length || 0})\n`;
  if (plan.scheduled?.length > 0) {
    for (const item of plan.scheduled) {
      const startLocal = item.start.slice(11, 16);
      const endLocal = item.end.slice(11, 16);
      const confidenceIndicator = item.duration_source === 'default' ? ' ⏱️(default)' : '';
      report += `- **${startLocal} - ${endLocal}** [${item.title}](https://todoist.com/app/task/${item.task_id}) [Score: ${item.score}]${confidenceIndicator}\n`;
    }
  }

  report += `\n\n## 📝 Manual Review Required (${plan.manual_review?.length || 0})\n`;
  if (plan.manual_review?.length > 0) {
    for (const item of plan.manual_review) {
      report += `- **${item.reason_code}**: [${item.title}](https://todoist.com/app/task/${item.task_id})\n`;
    }
  }

  report += `\n\n## ⏭️ Deferred (${plan.deferred?.length || 0})\n`;
  if (plan.deferred?.length > 0) {
    // Only show a summary of deferred reasons to reduce noise
    const reasons = {};
    for (const item of plan.deferred) {
      const code = item.reason_code || 'DEFERRED';
      reasons[code] = (reasons[code] || 0) + 1;
    }
    for (const [code, count] of Object.entries(reasons)) {
      report += `- **${code}**: ${count} task(s)\n`;
    }
  }

  report += `\n\n## 🤷 Unscheduled (Normal) (${(plan.unscheduled?.length || 0) - escalated.length})\n`;
  if (plan.unscheduled?.length > escalated.length) {
    report += `*(Tasks that did not fit the capacity without explicit escalation)*\n`;
  }

  if (isApply && plan.operations) {
    report += `\n\n## ⚙️ Operations Summary\n`;
    report += `- **Todoist Due Updates**: ${plan.operations.todoist_due_update?.filter(o => o.status === 'applied').length || 0} applied, ${plan.operations.todoist_due_update?.filter(o => o.status === 'failed').length || 0} failed\n`;
    // Calendar has no write operations (read-only availability only, 2026-09-05).
  }

  return report;
}
