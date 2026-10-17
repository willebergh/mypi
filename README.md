# mypi

Personal [Pi](https://pi.dev) extensions.

## Extensions

### Web

Provides provider-neutral web tools backed by dedicated integrations:

- `web_search` searches the live web through OpenAI's hosted Responses web-search tool and returns a concise answer with clickable inline citations. It uses Pi's existing `openai-codex` login and currently runs `gpt-6-luna`; no separate API key or login is needed.
- `web_scrape` uses Firecrawl to fetch the main content of one known HTTP(S) URL as Markdown.

The provider implementations live under `extensions/web/providers/`, so Firecrawl, Brave, Exa, or other backends can be added without changing the model-facing tool names. To verify hosted search with the current Pi-managed token, run `node scripts/probe-openai-web-search.mjs [optional query]`; it refreshes credentials through Pi and never prints the token.

### Image-generation probe

Run `npm run probe:image` to test Codex's image-generation endpoint with Pi's existing `openai-codex` login. It defaults to the Codex-managed `gpt-image-2` request and saves successful output under ignored `tmp/openai-image-probe/`. Pass `-- --route codex-images --model MODEL` to try another requested model, or use `--route images` / `--route responses` to compare the public OpenAI routes. The probe never prints the token.

The ChatGPT endpoint is undocumented and server-managed: it currently accepts even invalid model names, so a successful request does not prove that the requested model was selected. Public OpenAI image models require an API token with image scopes rather than the Codex OAuth token.

Copy `.env.example` to `.env` in this package and add `FIRECRAWL_API_KEY`. The extension loads this package-scoped file regardless of the project where Pi is running; variables already present in Pi's environment take precedence. Self-hosted Firecrawl deployments may also set `FIRECRAWL_API_URL`.

```bash
cp .env.example .env
# Edit .env and replace fc-your-key
```

Large scrape responses are truncated in model context and saved in full to a temporary Markdown file.

The `axios` override in `package.json` is intentional: the Firecrawl SDK currently pins an older vulnerable release. Remove the override once Firecrawl ships with a patched Axios dependency.

### Image generation

Adds `generate_image`, backed by Codex's image-generation endpoint and Pi's existing `openai-codex` login. It accepts a detailed prompt, a required absolute PNG output path, and optional aspect ratio and background mode. Each call saves the full PNG and also returns the image inline so the model can inspect it. Parent directories are created, and existing files are never overwritten.

The request uses Codex's `gpt-image-2` identifier, but the service controls the effective image model and does not report it. The tool therefore labels results as server-managed and does not expose a misleading model selector. This is an undocumented ChatGPT endpoint and may require updates if OpenAI changes it.

### Dictation

**Hold Space continuously for one second** to start dictation. Text appears live in the prompt; release Space to stop and finalize it. Quick taps type a normal space; holding does not insert repeated spaces. Wait for the **Listening** indicator before speaking (connecting can take longer than the one-second hold). Releasing while still connecting cancels startup. Nothing is submitted automatically, and existing prompt text is preserved.

Uses **`gpt-live-transcribe`**, with expected languages **`["en", "sv"]`** for English/Swedish code-switching and **`delay: "low"`**. No transcription prompt is sent: the earlier bilingual instruction prompt could be echoed as invented speech. Language hints are not a strict output filter.

The model streams partial text during uninterrupted speech without waiting for a pause or an audio commit. Release Space to commit the turn and wait for its final transcript. Unlike the previous model, it does **not support server VAD**, so the old 0.03 detection threshold, prefix padding, and 300 ms silence settings no longer apply. There are no arbitrary periodic audio cuts. Processing/network latency still applies. On release, 250 ms of generated silence is appended before the final commit to give short utterances trailing context; the microphone is not kept open for this. SoX uses a smaller 1024-byte processing buffer to reduce short-recording buffering. These are short-utterance robustness measures, not a guarantee of model recognition. An empty result reports whether no audio was captured or the service returned no text. Partial text is replaced by finalized text without duplication. The live insertion begins at the prompt cursor; updates can move the cursor to the end. Cancelling removes the provisional text and restores the original draft. If you independently edit the prompt during dictation, further updates cancel rather than overwrite those edits. Short clips are finalized on release.

The below-input dashboard shows a microphone indicator immediately left of weekly usage: **Mic off**, **Connecting**, **Listening**, or **Transcribing**. Listening appears only after microphone audio starts arriving; Transcribing means capture is stopping/stopped while final text finishes.

Hold-to-talk requires **Kitty keyboard protocol with key-release reporting** (for example Kitty or Ghostty). The extension requests reporting for unmodified keys while loaded and restores Pi's keyboard mode on shutdown/reload. Standalone modifier reports (Shift, Ctrl, etc.) are consumed so their private-use key codes cannot appear as typed symbols. Without protocol support, Space stays a normal typing key; there is no unreliable repeat-gap approximation. `/dictate` remains a manual start/stop toggle, and `/dictate cancel` discards an active recording or pending transcription. The previous Ctrl+Shift+D shortcut is removed.

Uses **Pi's existing `openai-codex` credentials**, refreshed by Pi, even when another chat provider is selected. No separate voice provider, login, or API key is created. Other providers' tokens (including the newer `openai` ChatGPT login) are not substituted. OpenAI must accept your Codex token for `gpt-live-transcribe`; this new model's compatibility with that login still needs a live test. Subscription eligibility, limits, and billing are not guaranteed by the published API pricing. Setup fails visibly if rejected; it does not silently switch models or authentication.

Microphone capture uses **SoX** (`rec`) and the default input device. On macOS, install it with `brew install sox` if needed and allow your terminal microphone access in **System Settings → Privacy & Security → Microphone**. Audio streams directly to OpenAI's realtime transcription endpoint using `gpt-live-transcribe`; no local audio files are saved. Recording stops automatically after two minutes. Reload, session changes, and tree navigation cancel dictation and release the microphone.

This is dictation only: no spoken replies, browser/LAN server, native binary, or voice conversation state. The downloaded `pi-gpt-voice/` reference package is not loaded or required. Uses a direct WebSocket connection (no custom endpoints or proxy configuration).

### Talk (experimental)

**Extension-only shared context:** completed, identified native voice turns are added to this Pi session as labelled `talk-history` custom messages using `triggerTurn: false`. They are visible to Pi on its next request, participate in normal compaction, and appear in the chat without starting inference. This needs no Pi fork, patched runtime, provider-payload hook, or new login. The model receives these messages as user-role **reference context**, with bracketed speaker headers and truthful source-model metadata—not fabricated native assistant responses or token usage. See the conservative recording limits below. Voice questionnaires remain experimental; use the terminal for consequential approvals until the live path is verified.

`/talk` adds a **full-duplex `gpt-live-1-codex` voice interface to the current Pi session** through the original package's Codex WebRTC route. The voice model is instructed to act as the speaking voice of the same assistant, owning requests through internal delegation and results rather than describing Pi as a separate helper. Routine bridge notices use first-person or neutral wording. Actions and status must still be grounded in confirmed events/tool results, and the distinct voice/coding models are explained honestly when asked. The existing coding agent still runs tools. Space-held dictation and prompt insertion are unchanged; `/talk` never directly reads or writes the input draft. The explicit **Stop Pi** action described below invokes Pi's normal Escape workflow, which returns queued text to the editor. The public `gpt-live-1` route rejected the existing credential with `Voice session access denied`, so it is no longer the default transport.

Run `/talk` and wait for **Talk live** before speaking. A **locally built native macOS helper** handles CoreAudio microphone/speaker, WebRTC/Opus, and acoustic echo/noise/gain processing. No browser, localhost page, or SoX playback is started. **Headphones are recommended** for the first live test. Grant microphone permission to the terminal/app running Pi in **System Settings → Privacy & Security → Microphone** if requested. The helper opens local capture during negotiation but does not transmit microphone audio until its data channel is ready. The below-editor resource dashboard shows summarizing, native startup, Codex connection, and WebRTC setup progress in the mic slot immediately left of weekly usage.

Build the Rust WebRTC helper, Swift FaceTime helper, and locally signed FaceTime app bundle with **`npm run talk:build`**. Requirements: macOS arm64/x64, Xcode tools/SDK with Swift 6, rustup with the pinned **Rust 1.99.0** toolchain, `pkg-config`, and static Opus (Homebrew `opus` includes it). Use `npm run talk:facetime:build` for a Swift-only rebuild/package, and `npm run talk:facetime:install` to install the app under `~/Applications`. Rebuild after source changes, with active calls stopped and the helper quit. Ad-hoc signing is local and needs no developer account; rebuilding can require a fresh manual Accessibility grant. The build script checks prerequisites; it does not install them or change your default Rust toolchain. Cargo may download locked dependencies. The current Mac's helper has already been compiled locally. Source, attribution, license notices, and detailed build instructions are in [`extensions/talk/native/README.md`](extensions/talk/native/README.md). Generated binaries and Cargo output are gitignored.

Commands:

- `/talk` or `/talk start` — regular Talk using the **physical** audio profile.
- `/talk facetime` — enable FaceTime standby using the **virtual** profile. GPT-Live connects per call; allowlisted incoming calls are answered when Talk is ready.
- `/talk facetime status|answer|hangup` — inspect/control the current owned FaceTime call. Hangup returns to standby.
- `/talk facetime call PHONE_OR_EMAIL [--reason CALL_PURPOSE]` — explicitly call an allowlisted recipient, optionally supplying what to discuss after they answer.
- `/talk stop` — close voice and any owned FaceTime call, exit standby, and reap the helper; Pi's queued/running work is not aborted.
- `/talk status` — show current mode/voice state and the active call's microphone/output selections.
- `/talk devices` — first choose **Physical** or **Virtual**, then select that profile's microphone/output; cancel any picker to leave settings unchanged. `/talk devices physical` and `/talk devices virtual` skip the profile picker.
- `/talk devices physical reset` or `/talk devices virtual reset` — clear just that profile.
- `/talk devices reset` — clear both audio profiles in a valid shared config; preserve call policy.
- `/talk log on` — enable private local GPT-Live event tracing, including during an existing call.
- `/talk log off` — stop logging and flush/close the file; saved logs remain.
- `/talk log status` — show the trace path, on/off state, and dropped-event count.

**Audio profiles:** `physical` is used by regular Talk and permits macOS defaults. `virtual` is reusable service audio routing; FaceTime requires explicit input/output choices with no physical fallback. Profiles and FaceTime policy share owner-only `~/.pi/agent/talk.json` (under `getAgentDir()` for custom Pi directories). Old settings migrate with private backups; audio reset preserves call policy. Swift derives FaceTime's inverse pair from the same virtual profile, with no duplicate device settings. See the [configuration reference](extensions/talk/CONFIG.md). Device listing does not open audio streams or contact OpenAI. Profile edits never rewire an active call; restart the mode to apply them. Missing selected devices fail startup rather than silently falling back. Dictation/browser audio is unchanged.

**FaceTime setup:** select `/talk devices virtual` to create the shared config, edit its `facetime` allowlists, run `npm run talk:facetime:install`, and open `~/Applications/Pi FaceTime Bridge.app` through Finder/LaunchServices. Its menu provides explicit Accessibility permission/settings controls, so the intended grant belongs to the bridge app rather than CMUX; actual attribution must be verified on your Mac. Open FaceTime too. Stop any old CLI service before launching the app. The developer CLI (`npm run talk:facetime`) remains available, but can attribute Accessibility to its terminal. See [local app setup](extensions/talk/facetime/APP.md). Then enable `/talk facetime` in Pi. The idle service reloads that same config and automatically applies the inverse virtual pair; Pi verifies routing before standby. For custom agent directories, use the app's **Choose Talk config…** menu and Stop/Start so its reported path matches Pi's. The service remains independent; Pi does not install or auto-start a daemon. A machine-wide lease permits one controlling Pi session. Tools (`facetime_status`, `facetime_call`, `facetime_answer`, `facetime_hangup`) are exposed only in this mode and are rejected outside it. Both audio directions remain gated until verified connection. An outgoing call then supplies quiet connection/purpose context and the speakable greeting **"Hello sir"** only. GPT-Live is instructed to wait for the user's first fresh reply (even "hi") before explaining the purpose naturally. That acknowledgement confirms audibility, not task approval or an answer to any pending question. The agent's `facetime_call` tool requires a concise `reason` based on known context/verified facts; manual calls without a purpose ask what to discuss after the acknowledgement. This is prompt-guided conversation flow, not a new permission mechanism. The greeting is not sent for incoming/failed calls or replayed after a reconnect. Ending a call returns to standby; `/talk stop` exits the mode. Transcripts, captions, delegation, and permissions use the same existing Talk pipeline. Standby/unavailable state appears in the dashboard's existing Talk/mic slot, not a separate footer. An observed end/failure of an owned call queues a hidden, labelled lifecycle message as a native follow-up with `triggerTurn: true`, so the agent receives it even if its current final response finishes first. This can schedule an additional model turn; it is reference data, not an answer, permission, or request to repeat work. Pending FaceTime voice questions return cancelled/unanswered (confirmed earlier answers retained), unblocking Pi instead of opening a terminal fallback. See [FaceTime integration](extensions/talk/facetime/INTEGRATION.md) for setup, command semantics, reconnect behavior, and the accepted current-call/stale-command limitation.

Uses the **same Pi-managed `openai-codex` credential lookup** as dictation, with no separate login or API key. Pi sends the SDP offer to `https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`, with the original `openai-alpha: quicksilver=v2` header, `gpt-live-1-codex`, and Cove voice. Gleam is advertised for public GPT-Live but is not in the reference Codex voice list; testing it produced a data-channel access denial, so Cove is restored pending verification. The native helper's audio and data use the resulting WebRTC connection. The original npm extension and its prebuilt binary are **not installed, imported, or executed**. Instead, a reviewed source copy of its Rust helper is built locally, with MIT/Apache notices retained. Only local CoreAudio is enabled; automatic PulseAudio socket discovery is removed. Pi keeps the Codex token and performs authenticated signaling; the helper receives SDP and control/data messages, never that token or API-key environment variables.

This is an internal experimental route; account access and protocol stability are not guaranteed. Errors expose bounded credential-redacted diagnostics, not raw events/auth/SDP. Signaling fetch exceptions preserve an allowlisted network/HTTP cause rather than discarding it as a generic request failure; this adds no automatic retries or extra call creation. There is no automatic model/auth fallback. Helper startup has a five-second deadline, offer creation has fifteen seconds, and the Codex exchange/peer readiness have twenty-five seconds. One helper process is used per call, with bounded IPC and shutdown escalation; failed setup releases its audio resources. Calls auto-stop after ten minutes, with an explicit session-limit notice and restart hint. Published API pricing does not establish Codex subscription coverage, and this route does not expose confirmed final voice usage. Expected missing usage is recorded as metadata without a misleading closing notice. Stop when finished.

**Startup continuity:** before opening the microphone, the extension runs the installed **`pi -p --model openai-codex/gpt-6-luna --thinking off`** to summarize the current conversation branch using its existing login. Tools, extensions, skills, prompt templates, themes, context-file loading, project approval, and session persistence are explicitly disabled. Startup catalog networking is disabled with `--offline`; the summary's normal model request is still allowed. History goes through stdin, never shell interpolation or command-line arguments. This deliberately uses the installed CLI's own model/message implementation: mixing the package's Pi 0.87 context format with a running Pi 0.85 provider caused the previous summary failures before any API request. Input is limited to the latest 32 KiB of user/assistant text, labelled `talk-history` messages, and readable compaction/branch summaries; thinking, raw tool results, and opaque provider compaction are excluded. The summary is capped at 3 KiB and cached in memory for up to eight unchanged snapshots. The entire summary operation has a fifteen-second deadline (a real full-history summary exceeded the original eight-second limit). Failure warns and starts voice without prior context rather than breaking audio. The child has bounded stdout/stderr and is terminated on cancellation/deadline, with forced termination after 500 ms if needed. The warning and `/talk status` identify safe failure categories such as timeout, context read, unavailable CLI, failed summary command, excessive output, or empty response. When supplied by the original error, request failures also retain a fixed, credential-safe hint such as DNS failure, connection reset/timeout, TLS certificate failure, HTTP 401/403/429, or HTTP 5xx. Unknown causes remain unknown; raw provider errors and credentials are never displayed. The summary, current coding model, and compact activity snapshot seed the voice session as fallible reference data—not new instructions.

**Ongoing context:** subagent starts/completions/failures, todo changes, and actual tool start/return/error facts stream into voice as quiet, bounded updates. Tool facts contain names and status only—not arguments, paths, results, or partial output—and never imply the whole task succeeded. Submission and native-consumption notices remain distinct; the redundant generic agent-start notice is removed. Settlement status is still included. Updates are batched and capped; token streams, thinking, and subagent result dumps are excluded. Invented delegation filler remains disabled (`ack_filler: false`). For an unambiguously voice-owned request, Pi's actual public tool-call commentary is sent as `speakable` before tools run, prefixed `Pi commentary (work in progress):`; voice relays only the body, without an acknowledgement or a completion claim. Repeated consecutive commentary is deduplicated. Final answers still wait for settlement; unknown/foreign/ambiguous scopes and failed/aborted commentary are not spoken.

**Message format:** new saved turns use `[talk:user]\n…` or `[talk:assistant]\n…` headers, without closing tags, a prose/JSON wrapper, or an extra `[talk-history]` heading. Saved transcripts retain Pi's purple custom-message styling; delegated requests retain its normal user-message styling. Outer whitespace is trimmed and inner newlines are preserved. Literal speaker headers inside speech are backslash-escaped to distinguish them from the actual header; ordinary brackets, ampersands, and angle brackets stay literal. Source model and call/turn IDs remain in custom-message details. Older saved XML/prose transcripts can render in this style without rewriting their stored content.

**Voice follow-ups:** GPT-Live is instructed to answer status, recap, and follow-up questions directly from supplied context or known Pi results, without submitting another task. Quiet/reference updates mean no unsolicited speech, not silence when the user asks. It must distinguish submitted, confirmed handling, and completed states; unknown status stays unconfirmed. Requests for fresh work or unavailable facts still delegate immediately, including while Pi is busy. This is prompt guidance, not a local intent classifier; live behavior needs verification after `/reload` and restarting `/talk`.

**How Pi does the work:** Codex client delegation supplies a self-contained task. Only its explicit task text starts the **existing main Pi agent**, prefixed with a `[talk:user]` header. Its delegation ID is saved separately as `talk-delegation` metadata. The voice handling/reference-data rules are applied to the run's system prompt, not repeated in the visible user message. Completed voice transcripts are separate fallible reference context, never an inference trigger or tool approval. Tasks are bounded at 8 KiB and dispatch on the next event-loop tick. The voice model must resolve its own proposals into concrete action/target text: “okay, do it” is not a valid handoff. Bare acknowledgements/deictic tasks are refused locally with one clarification per user turn, not sent to the coding agent. Pi retains its selected model, conversation context, tools, and permission checks. Transcript fragments alone do not start work, and delegations without task text are refused. Duplicate IDs are ignored. Fresh requests use Pi's native `sendUserMessage(..., { deliverAs: "followUp", expandPromptTemplates: false })` queue even while Pi is busy; Talk does not maintain a replacement execution queue. Pi retains its configured follow-up batching mode. Native input observation is not an enqueue/execution receipt: source transcripts and captions remain reserved until a correlated native user message is actually consumed. Waiting in the native queue has no ten-second startup deadline, and uncertain submissions are never retried automatically. Typed steering, competing identical inputs, or uncertain grouping must not return an unrelated result under a voice delegation. Several follow-ups can share one native answer; one answer per delegation is not guaranteed. Concurrent identical prompts remain distinct native submissions, but their voice attribution may be ambiguous; the bridge reports uncertainty rather than guessing. Per-request reference/permission guidance also covers follow-ups in an already-running Pi loop. Only eligible assistant text—not thinking or raw tool output—is returned. `/talk stop` detaches voice but does **not** cancel already-submitted native queued or running work; manage that queue in Pi.

**Experimental voice stop:** say **“Stop Pi”** or **“stoppa Pi”** on its own, after voice finishes speaking. A local handler—not a queued coding task—checks fresh identified user-ASR fragments, the matching current speech group, the same active Pi operation/signal, and its single-use call control. Group/fragment IDs alone do not prove a completed utterance: the native handoff commits the entire currently captured speech. Negated, conditional, quoted, compound, final-only, stale/replayed, or overlapping speech cannot authorize it; ordinary descriptive questions about Stop Pi still route normally. If identity/handoff events are missing or intent is uncertain, nothing is aborted by voice: use keyboard Escape. The voice model must never stop autonomously. This requests **normal TUI Escape behavior**: interrupt current work **and return native queued messages to the editor**, while keeping Talk connected. It is not queue-preserving, not Undo, and cannot guarantee that a tool ignoring cancellation has stopped. Old voice result scopes are detached so they cannot announce stale completion. A waiting `ask_user` dialog follows its tool abort signal, including an already-open terminal fallback. `/talk stop` remains voice-only and does not abort Pi.

**Typing while Talk is active:** normal terminal submissions, public tool-call commentary, and Pi's final replies are mirrored to Live as quiet, reference-labelled `commentary` context, not requested spoken output. Public commentary is sent before tools run, deduplicated, and labelled as work in progress—not a final reply. This does not insert another Pi message or start another request. Voice/extension/RPC inputs are not mirrored as terminal submissions; thinking and tool results are excluded. Reply forwarding normally waits for `agent_settled`. If a queued voice follow-up takes over first, the terminal's completed answer is mirrored quietly at that native-user boundary; tool-call commentary is not treated as a completed answer. Other extension/RPC inputs and call cleanup revoke ownership. Context updates use the existing bounded Live-update size, so long text may be truncated. Nothing is forwarded after Talk stops.

**Questions over voice:** while Talk is live, `ask_user` asks one question at a time, with numbered choices, single/multiple selection, free text, and Skip. Say a label or number (English/Swedish number words work); give multiple choices together. Pi reads back the **canonical option label**, not just the spoken number, and waits for a separate confirmation. Natural English/Swedish replies such as **yes please / yeah / ja tack / japp** work; **No / Nej** changes the answer. Conditional or contradictory approval does not authorize anything. **repeat / upprepa**, **skip / hoppa över**, **cancel / avbryt**, and **keyboard / terminal** are available. The current question/options appear in a temporary widget. The widget and `/talk status` show `listening`, `missing commit`, or `wait readback`. Replies no longer depend on a user `turn.done` event: the live service may keep sending transcript fragments while Pi waits for an answer. Each prompt supplies a fresh nonce; GPT-Live silently delegates the exact reply object (`{"talk_answer":"<nonce>"}`) after hearing the user's reply. Pi consumes only its own captured user speech, never answer text invented by the model. Regular Talk disconnects, two-minute inactivity, or questions too large for a reliable voice prompt fall back to the normal terminal questionnaire. FaceTime voice loss instead returns a pending voice question cancelled/unanswered, preserving only confirmed prior answers, so the agent can continue; it never supplies approval. New questions while FaceTime is merely in standby use the terminal normally. Tool cancellation cancels the question instead of opening a late dialog. Only newly captured user speech plus a matching current reply nonce can answer; assistant speech, stale nonces, delayed user finals, and fabricated answer fields cannot. Confirmation additionally waits for the current canonical readback to finish (not unrelated assistant speech) and discards speech captured before that point; no timer ever approves an answer. The voice model reads confirmation prompts verbatim. Final-only captions and correction suffixes remain display-only, never fresh speech for a later nonce. Changing topics ends the questionnaire instead of trapping the conversation in a Yes/No loop. A confirmation plus a new request records only confirmed answers and returns the new request directly in the existing `ask_user` tool result. A topic change without confirmation leaves the candidate unconfirmed. Remaining questions are marked unanswered; no hidden steering, queued user message, or full voice transcript is injected.

After a questionnaire, a new project handoff must match freshly captured ASR and must not just be a question's option label. Model paraphrases, added instructions, delayed finals, retired JSON reply controls, and assistant speech cannot supply a fresh task. A matching concrete handoff needs no extra task readback/Yes prompt; vague requests are clarified instead. Ordinary permission/approval dialogs remain in Pi's normal UI; this does not auto-approve them.

Stopping voice cancels undispatched local submissions/confirmations but **does not abort native queued or running Pi work**. A waiting regular-Talk voice questionnaire falls back to the terminal; a FaceTime voice questionnaire returns cancelled/unanswered to release the waiting tool. Work continues visibly there; results cannot leak into a later voice session.

The **mic slot immediately left of weekly usage in the below-editor dashboard** shows Talk's setup phase (including summarizing/connecting), then **Talk live MM:SS** (or **HH:MM:SS** for longer durations), and stopping state. The elapsed clock starts when the voice connection becomes active, refreshes every second even while quiet, and clears on stop/session changes; it is not confirmed server/billing usage. There is no duplicate status/progress/timer header above the input; that widget contains only captions and, for the optional browser adapter, its actionable local link. The caption widget shows at most **one You caption and one Voice caption**, each live or completed. A new utterance replaces that speaker's previous caption immediately, without removing the other speaker's caption or changing saved history. Final transcripts correct their own utterance instead of being appended to an ever-growing speaker row. Long live captions follow the newest words; completed summaries are clipped. Rendering wraps safely to the terminal width and caps each caption at three live rows or two completed rows.

**Voice reference history:** streaming captions remain temporary; only nonempty native `turn.done` transcripts with actual server turn IDs become `talk-history` entries. Entries retain source model, call/turn identity and any valid server timestamps. Repeated IDs do not duplicate entries; unknown-ID, missing/null final transcripts and unfinished speech are not saved. Individual turns are bounded at 16 KiB and recording at 256 unique turns per call; a history error disables recording, not audio. Messages are submitted to Pi's context-only queue, not treated as a filesystem acknowledgement; active tool batches finish before queued context is inserted. In an existing persisted Pi session they are stored normally and survive resume/fork; on a completely fresh custom-only session, Pi may buffer them until the first ordinary conversation turn creates its session file. No artificial user turn is inserted to force a file.

**Delegated-user deduplication:** native handoffs can identify their source speech with `item.user_bidi_turn_id`, matched exactly to the final user turn's `id`. Once Pi acknowledges that native request, the matching custom user transcript is omitted, leaving the native request as its only chat/model-context copy. Matching finals are held while native submission/consumption is pending. Undispatched or rejected submissions release their speech as ordinary reference history. Submitted native work can outlive Talk: stopping voice detaches its held speech rather than reinserting a duplicate while Pi still owns the queued request. Busy/questionnaire-consumed handoffs and missing/invalid source IDs never suppress user transcripts via deduplication; text or timing is not used to guess a link. A source speech turn can span multiple requests while Pi works. Repeated handoffs are deduplicated by **source turn ID plus normalized task text**: identical repeats are ignored, different tasks within that same turn can queue, and identical words in distinct turns remain distinct. The link and call ID are retained in delegation metadata. If the transcript was already submitted before the handoff arrived, this patch does **not** retract or rewrite it: both copies remain, and `/talk status` reports the late link. This is an explicit extension-API limitation, not silently discarded work.

**Conservative exclusions:** assistant history uses a conversation-turn guard, not a call-wide mute. A native handoff or Pi-supplied reply closes the recording window; this includes quiet terminal commentary/reply mirrors, which Live may still paraphrase aloud. A fresh identified user `turn.created` followed by its valid, non-delegated final reopens recording for voice-assistant turns that start afterward. Assistant turns already in progress cannot become eligible retroactively; another user boundary, handoff, or Pi reply invalidates overlapping output. Unknown-start assistant finals and stale user finals cannot reopen recording after a pause. This is a conservative event-ordering policy, **not** a proven assistant/readback ID link or a timer/count heuristic. Ordinary identified user turns continue to be recorded. After the first voice questionnaire, all transcript recording pauses for the rest of that call to exclude tool questions, answers and uncertain late finals; confirmed answers and topic changes still reach Pi through the existing `ask_user` tool result. A new `/talk` call resets these recording guards. `/talk status` reports submissions, exclusions and recording failures. Identified captions clear once their matching custom message is present in Pi's active branch, or the linked native delegation has acknowledged startup. Native `turn.created` binds live captions to actual turn IDs, so an acknowledged request can hide its still-live caption before delayed `turn.done`; subsequent fragments from that turn stay hidden. Queued custom messages keep their captions until they reach the branch (checked on the existing one-second refresh). Speech not yet represented in Pi—including unidentified/excluded turns—stays visible until replaced by that speaker's next utterance or Talk stops; text matching is never used to clear them. All captions clear when Talk stops or the session changes; saved context remains in Pi history. Starting dictation stops Talk to avoid competing microphone sessions; finish dictation before starting Talk. Reload, shutdown/session changes, and tree navigation also close Talk.

Talk uses native WebRTC; dictation still uses its unchanged SoX pipeline. No local audio files are saved. Server-side retention is governed by the Codex service, not a storage setting in this customization. Captions live in memory; eligible completed voice turns persist as labelled custom context, while delegated requests/results remain in normal Pi history, and a small `talk-usage` entry records that final server usage is unconfirmed. The startup summary uses the short-lived, tool-disabled `pi -p` subprocess described above; there is no separate long-running backend. There is no browser/relay server in the default path, automatic reconnect/retry, or runtime build/download. The locally built binary lives at `extensions/talk/native/bin/darwin-<arch>/pi-codex-voice` and is resolved relative to the extension, not the current project.

#### Live GPT-Live event trace (opt-in)

After `/reload`, enable `/talk log on` **before** starting `/talk` to capture the complete startup exchange. **Each new Talk call clears any existing `events.jsonl` and its `.1` rotation backup**, restarts sequence/drop counters, and ignores late events from the previous call. Copy the files elsewhere before restarting Talk if you want to keep them. Logging stays opt-in: when it is off, reset still clears existing logs immediately without creating files or enabling recording; toggling logging off/on within the same call otherwise preserves that call's records. In another terminal:

```bash
tail -F ~/.pi/agent/logs/talk/events.jsonl
# Optional pretty printing, if jq is installed:
tail -F ~/.pi/agent/logs/talk/events.jsonl | jq --unbuffered .
```

For a readable live Markdown monitor, run from this repository in another terminal:

```bash
node scripts/talk-monitor.mjs
# Export the current log as plain Markdown, then exit:
node scripts/talk-monitor.mjs --once > /tmp/talk.md
```

The dependency-free monitor replays the existing file and follows new records. Full-block backgrounds identify the scope:

- **Purple:** every delegation event—creation, commentary, and speakable updates.
- **Yellow:** every session event, including startup instructions/context.
- **Dark gray:** both user and GPT-Live voice.

Blocks have one uncolored blank separator line, including streamed voice blocks. Compact headers put the sender first and delegation ID last, with the content immediately below:

```text
[USER] [VOICE]
[GPT-LIVE] [VOICE]
[GPT-LIVE] [DELEGATION] [CREATE] [item ID]
[PI] [DELEGATION] [CONTEXT] [item ID]
[PI] [DELEGATION] [SPEAKABLE] [item ID]
[PI] [SESSION] [CONTEXT]
[PI] [SESSION] [SPEAKABLE]
[PI] [SESSION] [STARTUP]
```

`CONTEXT` means quiet `commentary`; `SPEAKABLE` means intended for spoken delivery, not proof of audible playback. Matching delegation IDs link requests to updates; creation alone does not establish execution or completion. Timestamps, sequence numbers, transport directions, and extra IDs are omitted.

**Speech ordering:** both user and GPT-Live speech stream from `turn.created` / `turn.delta`, rather than waiting for a potentially late `turn.done`. A matching final transcript does not add a duplicate block. Interleaved output closes the current speech block; subsequent fragments continue in a labeled block with the same speaker, and changed final transcripts remain visible as corrections. Final-only transcripts are still shown. ID-less deltas can only be associated with the latest ID-less creation. Duplicate transcript fragments, acknowledgements, lifecycle events, and usage are hidden; this is a focused conversation/context monitor, not a complete event inspector.

**Session resets:** startup, file truncation/rotation, and changed `callId` clear both the visible terminal and scrollback (where ANSI erase-scrollback is supported). Resets show a **Log reset / new session** banner. Comparing the file's beginning also catches a fast truncate/refill that grows beyond the old offset. Plain/redirected output retains text markers without terminal clearing.

Ctrl-C exits. Basic bold/inline-code styling and indented JSON controls improve readability. Redirected output or `--plain` is plain Markdown; `NO_COLOR` disables styling. An optional final path overrides the default, which respects `PI_CODING_AGENT_DIR`. Missing logs are awaited until logging is enabled. **Output contains private conversation/context text; protect exported files.**

For a minimal `{role, transcript}` view of completed speech, incoming delegation tasks, startup instructions/summary, and injected commentary/results, run this from the package directory:

```bash
tail -n +1 -F ~/.pi/agent/logs/talk/events.jsonl | jq --unbuffered -c -f scripts/talk-context.jq
```

This hides streaming fragments, usage, lifecycle metadata, and acknowledgements. Quiet `thinking` updates use the wire channel `commentary`; spoken result prompts use `speakable`. Changing this filter requires no Pi reload; restart the tail/jq pipeline to load an edited filter.

Use the exact path shown by `/talk log status` if `PI_CODING_AGENT_DIR` is customized. `tail -F` is preferable to `watch`: it streams new records and follows file rotation.

Each JSON line contains `time`, `seq`, `callId`, `direction` (`in`, `out`, or `local`), `type`, and `event`. For example:

```json
{"time":"2026-10-16T12:00:00.000Z","seq":42,"callId":"example-call","direction":"out","type":"session.context.append","event":{"type":"session.context.append","channel":"commentary","content":[{"type":"input_text","text":"Todo #15 completed."}]}}
```

- **Out:** actual startup session configuration—including instructions and the generated summary—and data-channel send attempts for context updates/results. A send attempt is **not** a server acknowledgement.
- **In:** raw server data-channel events, including unknown event types, before parsing, deduplication, or questionnaire routing.
- **Local:** setup phases, HTTP response status, safe request-failure hints, and shutdown. Enabling logging mid-call records a clearly labelled snapshot of the original startup configuration; it does not fabricate an earlier send or reconstruct missed events.

**These files contain private conversation/context text.** Tracing is off by default, is not persisted as a setting, and stops and flushes on reload or shutdown. It does not add messages to Pi's conversation. Known authentication values and credential fields are redacted; raw audio, binary payloads, and SDP are omitted/redacted. Files are owner-only (`0600`) in a private trace directory (`0700`). Records are bounded at 64 KiB, writes are queued with a 1 MiB bound, and overload is reported with `trace.dropped` rather than blocking voice. The stable file rotates at 5 MiB into one backup, `events.jsonl.1`. Logging failures disable logging, not the voice call. Use `/talk log off` when finished and delete both files when you no longer need them. This is diagnostic tracing, not an audio recorder or guaranteed lossless audit log.

### Context viewer

Adds `/context-viewer`, a full-height read-only view of Pi's effective system prompt. This is the instruction text assembled from Pi's base prompt, applicable context files such as `AGENTS.md`, tool guidance, and the skill catalog. It deliberately excludes user prompts, assistant replies, tool results, tool-schema JSON, and other diagnostic metadata.

In regular TUI mode, use the terminal's native scrollback or mouse/trackpad to scroll through the full rendered prompt. Press Escape or `q` to close. Native terminal scrollback is unavailable in fullscreen/alternate-screen mode.

### Nested AGENTS.md

Loads nested `AGENTS.md` instructions when Pi starts working with a path in their subtree. Pi already loads the root and ancestor `AGENTS.md` files; this extension adds the nested, path-scoped behavior.

The extension detects paths in prompts and in the built-in file/search/shell tools. Instructions are injected once per session, from the broadest applicable directory to the most specific. A first write, edit, or shell command is blocked and retried after newly discovered instructions enter model context. The resource-status widget shows the count and repository-relative directories whose nested `AGENTS.md` instructions were injected during the session.

### Monorepo skills

Discovers skills across the repository, but advertises nested skills only when their subtree becomes relevant:

- A skill below `package/ui/.agents/skills/` is scoped to `package/ui`.
- A skill below `apps/web/.pi/skills/` is scoped to `apps/web`.
- A literal skill path in `apps/web/.pi/settings.json` also adds `apps/web` as a scope for that skill. This allows one skill to belong to `packages/ui` while also applying in `apps/web`.

Scopes activate when the initial working directory, a prompt path, or a built-in file/search/shell tool enters them. Mutating tool calls are blocked once so the newly injected skill catalog reaches the model before the mutation is retried. The status widget lists a skill only after its `SKILL.md` instructions are actually invoked or read.

Pi currently requires skills to be registered during resource discovery for `/skill:name` expansion. The extension therefore registers the complete resource set internally, removes inactive skills from the model-facing system prompt, and advertises them only on scope activation.

The extension deliberately does not apply other nested Pi settings. Glob and negative selectors remain the responsibility of Pi's native settings loader; this extension follows literal paths and exact `+path` inclusions only. Repository scans skip dependency, VCS, coverage, and common build-output directories.

### Nested MCP

Discovers `.mcp.json` files across a repository and activates their servers only when the initial working directory, a prompt path, or a built-in file/search/shell tool enters the file's subtree. The first mutating tool call is blocked once so the activation notice reaches the model before the mutation is retried.

This is a deliberately minimal, first-party MCP client rather than a dependency on a third-party Pi MCP extension. It supports stdio commands plus unauthenticated SSE and Streamable HTTP servers with HTTP(S) URLs, including configs whose type is `"http"` or `"streamable-http"`. Stdio processes run with the `.mcp.json` directory as their working directory; configured environment variables are merged with the SDK's safe default environment. OAuth, custom HTTP headers, MCP resources, and MCP prompts remain unsupported.

Every server requires an explicit approval dialog before activation. Approval is stored against a hash of the scoped server definition in both the Pi session and the project-root `.pi/.mcp.auto.json`, allowing subsequent trusted-project sessions and RPC subagents to activate an unchanged server without another prompt. Changing its name, scope, transport, URL, or command requires approval again. Unapproved servers remain disabled in headless and RPC sessions, so subagents cannot block waiting for confirmation. Nested scans do not follow symbolic-link directories.

Servers connect lazily through the `mcp` gateway tool. Use `action: "servers"` to inspect active servers, `action: "tools"` to connect and discover tools, and `action: "call"` to invoke one. Scoped IDs such as `apps/website:astro` avoid collisions between identically named servers in different applications. `/mcp-status` shows the active set.

For Astro, place the generated configuration at `apps/website/.mcp.json`:

```json
{
  "mcpServers": {
    "astro": {
      "type": "sse",
      "url": "http://localhost:4321/__mcp/sse"
    }
  }
}
```

The Astro development server must already be running; the MCP client connects to its endpoint but does not start Astro itself.

### Resource status

Shows a unified live dashboard below the editor. Its top row keeps the session name on the left and the microphone indicator followed by the weekly OpenAI usage window on the right. A separate main-agent row contains elapsed time, resource counters, output throughput in `t/s`, and model-labeled context usage. Subagent runs appear beneath it as an aggregate row plus aligned per-agent rows; each child has its own `t/s` value and the aggregate is their sum. Rates use a roughly one-second rolling window of reported output tokens, excluding the initial wait for generation, and retain their last measurement between responses. Providers that report usage only at completion fall back to a whole-response average; before the first measurement the widget shows `— t/s`. Other OpenAI usage windows, todos, injected agent directories, and actually loaded skills follow in the same widget. OpenAI model labels omit the redundant `gpt-` prefix.

`A(N)`, `S(N)`, and `T(X/N)` mean loaded agent instruction files, loaded skills, and completed/total todos. Subagent aggregate counters and context values are sums across the displayed children, and aggregate elapsed time is the sum of their run times. The layout wraps into separate label and metrics lines on narrow terminals and refreshes elapsed values every second.

Extension participation is still tracked for the `/mypi-resources` command, but it is intentionally omitted from the always-visible dashboard. Pi does not currently expose a public API for enumerating every third-party extension and native skill.

### Ask user

Adds the `ask_user` tool for structured interactive questions instead of numbered questions in chat. One call can contain multiple questions, and each question supports either single-select or multi-select answers. The custom terminal questionnaire always adds **Free text…** and **Skip** choices. Multi-select questions allow combining suggested and free-text answers before continuing.

### Todos

Adds a model-callable `todo` tool whose state appears in the unified below-editor dashboard. The dashboard shows the latest completed item plus up to four incomplete items, summarizes additional active items, and keeps older completed items represented only in the count. The agent can list, add, complete, edit, remove, and clear items. State is stored in tool-result details so it follows the active session branch and reconstructs correctly after reload, resume, fork, or tree navigation. Use `/todos` to show the complete list in a notification.

### OpenAI subscription usage

Tracks the ChatGPT Codex subscription windows for the active `openai-codex` model. It reads Pi's existing OAuth token, requests usage from ChatGPT's usage endpoint, and publishes progress bars for the five-hour and weekly remaining percentages and reset times to the resource-status widget.

Usage refreshes when the session starts, after each turn, when the model changes, and every minute while an OpenAI Codex model is active. Use `/openai-usage refresh` for a manual refresh. Polling runs only in interactive TUI sessions and stops during shutdown or when another provider is selected.

The ChatGPT usage endpoint is an undocumented service endpoint and may require parser updates if OpenAI changes its response format.

### Subagents

Adds a generic `subagent` tool for starting up to sixteen independent tasks in isolated Pi RPC subprocesses. Calls return session-local agent IDs immediately, while one session-wide scheduler limits concurrency to four across every start call. The parent is instructed to choose explicitly among `openai-codex/gpt-6-luna` for focused, cost-sensitive work, `openai-codex/gpt-6.1-sol` for a strong intelligence/cost balance, and `openai-codex/gpt-6-astra` for the most demanding reasoning and coding. Omitting the model intentionally inherits the parent model. Tasks also inherit the parent thinking level, working directory, and project trust decision unless explicitly overridden. Child sessions are ephemeral and cannot recursively invoke subagent management or blocking interactive tools.

When a child completes, fails, or is aborted, a bounded custom message containing its task and outcome is delivered immediately into the main agent context. It steers an active main run or wakes an idle main agent, then the settled child is removed from the active registry. The parent is instructed not to poll merely to wait: it should continue independent work or end its turn and rely on the completion wake-up, while withholding a final answer when required results are still pending. `list_subagents` is reserved for real status checks or cancellation decisions and therefore reports only queued or running children. `cancel_subagents` accepts a list of session-local agent IDs. IDs are never reused within a session. Parent-turn cancellation does not cancel background children; session shutdown, reload, or replacement does.

The unified below-editor dashboard shows active aggregate and per-agent activity, IDs, elapsed time, resource counters, model, and context usage. Rows disappear after their outcomes are delivered. The chat start call presents each delegated task in its own Markdown quote block, while redundant status output stays hidden because it remains visible in the dashboard. It intentionally omits turn, raw usage-token, and dollar-cost fields. Subagents share the same working tree, so parallel tasks should not edit the same files.

This implementation runs inline in every terminal. Its worker/event model is intentionally independent of cmux so a later adapter can expose the same agents in visible cmux tabs without replacing the scheduler or widget.

## Development

```bash
npm install
npm test
npm run check
pi -e .
```

Install this directory as a personal local package:

```bash
pi install .
```

Use `/reload` after editing an installed local package.
