function keywordMatch(text, keywords) {
  return keywords.find((keyword) => text.includes(keyword));
}

// Remove markdown links ([text](url)) and bare URLs from text before
// regex-based duration extraction. URLs/issue-links contain numbers followed
// by "h" (https) which the duration regex misreads as "N hours" — e.g. an
// issue "#84" in a GitHub link was parsed as 84 hours. Verified systemic
// over-estimation 2026-09-05 (ideas-jetro/RZDC tasks inflated 10-100x).
function stripUrlsAndLinks(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links -> keep text
    .replace(/https?:\/\/\S+/gi, '')        // bare URLs
    .replace(/#\d+/g, '')                   // issue numbers (#84 -> removed)
    .trim();
}

export function estimateDuration(task, config) {
  if (task.duration) {
    return {
      duration_minutes: typeof task.duration === 'object' ? (task.duration.unit === 'minute' ? task.duration.amount : task.duration.amount) : task.duration,
      duration_source: 'todoist_duration',
      matched_rule: null,
      confidence: 1,
    };
  }

  const titleMatch = /\((?<value>\d+(?:\.\d+)?)\s*(?<unit>min|mins|minutes|h|hr|hrs|hour|hours)\)/i.exec(task.content);
  if (titleMatch?.groups) {
    const amount = Number(titleMatch.groups.value);
    const unit = titleMatch.groups.unit.toLowerCase();
    return {
      duration_minutes: unit.startsWith('h') ? Math.round(amount * 60) : Math.round(amount),
      duration_source: 'title_pattern',
      matched_rule: titleMatch[0],
      confidence: 0.95,
    };
  }

  const explicitDurationMatch = /(?<value>\d+(?:\.\d+)?)\s*(?<unit>min|mins|minutes|h|hr|hrs|hour|hours|時間|分)/i.exec(stripUrlsAndLinks(`${task.content} ${task.description}`));
  if (explicitDurationMatch?.groups) {
    const amount = Number(explicitDurationMatch.groups.value);
    const unit = explicitDurationMatch.groups.unit.toLowerCase();
    const isHours = unit.startsWith('h') || unit.startsWith('時間');
    
    return {
      duration_minutes: isHours ? Math.round(amount * 60) : Math.round(amount),
      duration_source: 'explicit_text_pattern',
      matched_rule: explicitDurationMatch[0],
      confidence: 0.95,
    };
  }

  const projectRuleMinutes = config.durationRules.projects?.[task.project_name ?? ''];
  if (projectRuleMinutes) {
    return {
      duration_minutes: Number(projectRuleMinutes),
      duration_source: 'project_rule',
      matched_rule: task.project_name,
      confidence: 0.85,
    };
  }

  for (const label of task.labels) {
    const labelRuleMinutes = config.durationRules.labels?.[label];
    if (labelRuleMinutes) {
      return {
        duration_minutes: Number(labelRuleMinutes),
        duration_source: 'label_rule',
        matched_rule: label,
        confidence: 0.82,
      };
    }
  }

  for (const rule of config.durationRules.taskPatterns ?? []) {
    const regex = new RegExp(rule.pattern, 'i');
    if (regex.test(task.content) || regex.test(task.description)) {
      return {
        duration_minutes: Number(rule.minutes),
        duration_source: 'task_pattern_rule',
        matched_rule: rule.pattern,
        confidence: Number(rule.confidence ?? 0.8),
      };
    }
  }

  const text = `${task.content} ${task.description}`.toLowerCase();
  for (const rule of config.keywordDurations) {
    const matchedKeyword = keywordMatch(text, rule.keywords);
    if (matchedKeyword) {
      return {
        duration_minutes: Number(rule.minutes),
        duration_source: 'keyword_rule',
        matched_rule: `${rule.category}:${matchedKeyword}`,
        confidence: Number(rule.confidence),
      };
    }
  }

  return {
    duration_minutes: Number(config.defaultDurationMinutes),
    duration_source: 'default',
    matched_rule: null,
    confidence: 0.35,
  };
}
