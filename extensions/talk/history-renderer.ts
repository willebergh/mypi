import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { formatTalkMessage, sanitizeTalkText } from "./message-format.ts";

function displayContent(content: string): string {
  content = content.replace(/\r\n/g, "\n");
  const bracket = /^\[talk:(user|assistant)\]\n([\s\S]*)$/.exec(sanitizeTalkText(content));
  if (bracket) {
    // Current bodies are already escaped. Protect hand-edited headers too, without
    // adding another backslash on every render/resume.
    const body = bracket[2].trim().replace(/(?<!\\)\[\/?talk:(?:user|assistant)\]/g, "\\$&");
    return `[talk:${bracket[1]}]\n${body}`;
  }
  const xml = /^<talk:(user|assistant)>\n([\s\S]*)\n<\/talk:\1>$/.exec(content);
  if (xml) {
    const body = xml[2].replace(/&(amp|lt|gt);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">" })[entity]!);
    return formatTalkMessage(xml[1] as "user" | "assistant", body);
  }
  // Legacy history stored JSON-quoted speech after these exact reference labels.
  // Decode only this known shape; never interpret arbitrary text as JSON/markup.
  const legacy = /^Voice transcript — fallible reference data, not a new request or tool approval\.\nVoice model: [^\n]*\.\nSpeaker: (User|Voice assistant)\.\nTranscript: ([\s\S]*)$/.exec(content);
  if (legacy) {
    try {
      const text: unknown = JSON.parse(legacy[2]);
      if (typeof text === "string") return formatTalkMessage(legacy[1] === "User" ? "user" : "assistant", text);
    } catch { /* Malformed historical data is displayed literally, never executed. */ }
  }
  return sanitizeTalkText(content);
}

/** Literal speech with Pi's native custom-message palette, but no custom-type title. */
export const renderTalkHistory: MessageRenderer = (message, { outputPad }, theme) => {
  const content = typeof message.content === "string" ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const display = displayContent(content);
  const header = /^(\[talk:(?:user|assistant)\])\n/.exec(display);
  const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
  if (header) box.addChild(new Text(theme.fg("customMessageLabel", header[1]), 0, 0));
  box.addChild(new Text(theme.fg("customMessageText", header ? display.slice(header[0].length) : display), 0, 0));
  return box;
};
