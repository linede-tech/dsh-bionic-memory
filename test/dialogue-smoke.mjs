/**
 * Episodic dialogue is the visible conversation, not the agent's scratchpad.
 * These cases protect the final-answer-only rule.
 */

import {
  recordAssistantMessage,
  recordToolExchange,
  visibleAssistantText,
} from '../lib/dialogue.js';

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`ok - ${message}`);
  else {
    failures += 1;
    console.error(`FAIL - ${message}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
  }
}

const buffer = { assistant: [], assistantAt: 0 };

recordAssistantMessage(buffer, '我先看一下相关文件。', 1000);
check(visibleAssistantText(buffer) === '我先看一下相关文件。', 'assistant preamble is visible before any tool');

recordToolExchange(buffer);
check(visibleAssistantText(buffer) === '', 'assistant preamble is dropped when a tool call starts');
check(buffer.assistantAt === 0, 'tool exchange clears the assistant timestamp');

recordAssistantMessage(buffer, '最终回答：已经改好了。', 2000);
check(visibleAssistantText(buffer) === '最终回答：已经改好了。', 'final answer after the tool is retained');
check(buffer.assistantAt === 2000, 'final answer keeps its own timestamp');

recordAssistantMessage(buffer, '第一条可见回复', 3000);
recordAssistantMessage(buffer, '最后一条可见回复', 4000);
check(visibleAssistantText(buffer) === '最后一条可见回复', 'only the last visible assistant message survives without tools');

recordToolExchange(buffer);
recordAssistantMessage(buffer, '   ', 5000);
check(visibleAssistantText(buffer) === '', 'blank assistant text does not resurrect a tool preamble');
check(buffer.assistantAt === 0, 'blank assistant text does not set a timestamp');

recordAssistantMessage(buffer, '', 6000);
check(visibleAssistantText(buffer) === '', 'empty assistant message is ignored');

if (failures) {
  console.error(`\nFAIL: ${failures} failed assertion(s)`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: 0 failed assertion(s)');
}
