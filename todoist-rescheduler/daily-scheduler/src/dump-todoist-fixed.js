import { TodoistClient } from './todoist.js';
import { parseCli } from './config.js';
import { createLogger } from './logger.js';
import { normalizeStoreState } from './normalize.js';
import { TaskStore } from './memory.js'; // Let's guess where loadState logic lives or just fetch raw Todoist

async function run() {
  const options = await parseCli(process.argv.slice(2));
  const client = new TodoistClient(options.todoistToken);
  const tasks = await client.getTasks();
  
  const tasksWithDesc = tasks.map(t => ({
    id: t.id,
    content: t.content,
    description: t.description,
    priority: t.priority,
    due_date: t.due ? (t.due.date || t.due.datetime) : null
  }));
  
  console.log(JSON.stringify(tasksWithDesc, null, 2));
}
run().catch(e => { console.error(e); process.exit(1); });
