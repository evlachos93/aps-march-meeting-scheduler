#!/usr/bin/env node

'use strict';

const { readFile, writeFile } = require('fs/promises');
const path = require('path');

const DATA_PATH = path.resolve(__dirname, '../data/talks.json');
const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})/;
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });

// Extract the conference day from the ISO timestamp so local offsets cannot shift the weekday.
function weekdayFromTimestamp(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day] = match[1].split('-').map((segment) => Number(segment));
  if ([year, month, day].some(Number.isNaN)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return WEEKDAY_FORMATTER.format(date);
}

async function main() {
  const content = await readFile(DATA_PATH, 'utf-8');
  const payload = JSON.parse(content);
  if (!payload || !Array.isArray(payload.talks)) {
    console.error('Invalid talks.json payload, no talks array found.');
    process.exitCode = 1;
    return;
  }

  let updated = false;
  const talks = payload.talks.map((talk) => {
    const weekday = weekdayFromTimestamp(talk.startTime);
    if (!weekday || talk.weekday === weekday) {
      return talk;
    }
    updated = true;
    return { ...talk, weekday };
  });

  if (!updated) {
    console.log('Weekday metadata is already up to date.');
    return;
  }

  const output = JSON.stringify({ ...payload, talks }, null, 2) + '\n';
  await writeFile(DATA_PATH, output, 'utf-8');
  console.log(`Updated ${talks.length} talks with weekday metadata.`);
}

main().catch((err) => {
  console.error('Failed to update talk weekdays:', err);
  process.exitCode = 1;
});
