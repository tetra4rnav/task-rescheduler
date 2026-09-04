#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
}

walk(path.join(root, 'src'));
walk(path.join(root, 'bin'));
walk(path.join(root, 'tests'));
walk(path.join(root, 'scripts'));

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  const text = fs.readFileSync(file, 'utf8');
  if (/\t/.test(text)) {
    throw new Error(`Tabs are not allowed: ${path.relative(root, file)}`);
  }
}

console.log(`lint ok (${files.length} files)`);
