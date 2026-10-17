# Minimal context view: completed speech and prompts injected into GPT-Live.
def content_text: [.content[]? | .text? // empty] | join("\n");

.event
| (if .type == "trace.session_snapshot" then .startup else . end)
| if .type == "turn.done" then
    {role: .turn.role, transcript: .turn.transcript}
  elif .type == "codex.call.create" then
    {role: "instructions", transcript: .session.instructions},
    (.session.initial_items[]? | {role, transcript: content_text})
  elif .type == "delegation.created" then
    {role: "delegation", transcript: (.item | content_text)}
  elif .type == "session.context.append" or .type == "delegation.context.append" then
    {role: .channel, transcript: content_text}
  else empty end
| select((.role | type) == "string" and (.transcript | type) == "string" and .transcript != "")
