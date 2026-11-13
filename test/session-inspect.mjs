/**
 * Decode a DSH v4 session log (zstd-compressed JSONL) and report whether the
 * bionic memory context reached the assembled system prompt.
 *
 * Usage: node test/session-inspect.mjs <session.v4.jsonl.zstd>
 */
import fs from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('usage: node test/session-inspect.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}

const raw = zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
const lines = raw.split('\n').filter((line) => line.trim());
console.log(`events: ${lines.length}`);

let systemMessages = 0;
let latest = null;
let latestSystem = null;
const eventTypes = new Map();

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  const type = event.type ?? event.event?.type;
  if (type) eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
  if (type !== 'system/message') continue;
  systemMessages += 1;
  const message = event.data?.message ?? event.message;
  const content = message?.content;
  const text = Array.isArray(content)
    ? content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n')
    : typeof content === 'string'
      ? content
      : '';
  latestSystem = {
    time: event.time ?? event.at,
    text,
    injected: text.includes('<bionic_memory_context>'),
  };
  if (text.includes('<bionic_memory_context>')) {
    latest = { time: event.time ?? event.at, text };
  }
}

console.log(`system messages: ${systemMessages}`);
if (latestSystem) {
  const time = latestSystem.time ? new Date(latestSystem.time).toISOString() : 'unknown';
  console.log(
    `LATEST SYSTEM: ${time}, ${latestSystem.text.length} chars, injected=${latestSystem.injected}`,
  );
}
console.log(
  'event types:',
  [...eventTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(', '),
);

if (!latestSystem) {
  console.log('INJECTION: no system message logged');
  process.exitCode = 1;
} else if (!latestSystem.injected) {
  const currentTime = latestSystem.time ? new Date(latestSystem.time).toISOString() : 'unknown';
  console.log(`INJECTION: absent from the latest system message (${currentTime}, ${latestSystem.text.length} chars)`);
  if (latest) {
    console.log(
      `LAST INJECTION: ${new Date(latest.time).toISOString()} (${latest.text.length} chars, historical)`,
    );
  }
  process.exitCode = 0;
} else {
  const latestMessage = latestSystem;
  const time = latestMessage.time ? new Date(latestMessage.time).toISOString() : 'unknown';
  const checks = {
    identityRules: latestMessage.text.includes('<system_identity_and_cognitive_rules>'),
    contextRoot: latestMessage.text.includes('<bionic_memory_context>'),
    timeAwareness: latestMessage.text.includes('<time_awareness>'),
    scratchpad: latestMessage.text.includes('<subconscious_scratchpad>'),
    dreamResidue: latestMessage.text.includes('梦境残留'),
    recalled: latestMessage.text.includes('<recalled_memories>'),
    sourceLabels: latestMessage.text.includes('[用户亲述]') || latestMessage.text.includes('[我的推测'),
    newCognitiveRules: latestMessage.text.includes('记忆来源防伪'),
  };
  console.log(`INJECTION: found (system message at ${time}, ${latestMessage.text.length} chars)`);
  console.log('checks:', JSON.stringify(checks));
  const start = latestMessage.text.indexOf('<bionic_memory_context>');
  console.log('--- context snippet ---');
  console.log(latestMessage.text.slice(start, start + 900));
  if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
}
