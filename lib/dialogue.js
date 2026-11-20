/**
 * Visible-dialogue selection for episodic ingestion.
 *
 * A single Turn can contain several assistant messages, reasoning blocks and
 * any number of tool calls/results. Only the final visible assistant message
 * after the last tool exchange belongs in an episodic memory. Intermediate
 * commentary and tool output are operational telemetry, not conversation.
 */

export function recordAssistantMessage(buffer, text, time = 0) {
  const clean = String(text || '').trim();
  if (!buffer || !clean) return false;
  // A later assistant message supersedes an earlier one. The loader emits the
  // final answer last; intermediate messages are not concatenated.
  buffer.assistant = [clean];
  buffer.assistantAt = Number(time) || Date.now();
  return true;
}

export function recordToolExchange(buffer) {
  if (!buffer) return;
  // Everything before a tool call is preamble. Wait for the answer after the
  // final tool result; if there is none, the episode keeps only the user turn.
  buffer.assistant = [];
  buffer.assistantAt = 0;
}

export function visibleAssistantText(buffer) {
  return Array.isArray(buffer?.assistant) ? buffer.assistant.join('\n').trim() : '';
}
