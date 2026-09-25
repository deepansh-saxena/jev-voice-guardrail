# Relay Guardrail Lab

A local, synthetic subscription-support lab comparing **TypeSafe Jev** with a separately configured **structured-output LLM judge**. React + TypeScript + Vite, Node + TypeScript. Native Azure OpenAI Realtime WebRTC audio; backend sideband owns response creation, transcripts, and guardrail decisions.

**Original local verification (September 24, 2026):** Azure authenticated client-secret creation (HTTP 200), SDP negotiation (HTTP 201), authenticated sideband gate confirmation and a real Chromium WebRTC peer connection passed a no-audio/no-inference probe. Both Jev (`jev-1.13.0`) and the independently configured Azure LLM judge (`gpt-5.4-mini-2026-03-17`, `reasoning_effort=none`) responded to four real input/output allow/violation probes; all four aggregate decisions matched authored expectations. These are integration smoke checks, **not** a benchmark or validated accuracy result. Jev returned additional per-policy uncertainty on some probes, which is preserved in the private local reports. Credentials and run reports are **not included in this repository**; a fresh checkout starts without either.

**Still blocked in the original setup:** no separate transcription deployment exists on its Realtime resource. The implemented input gates require a supported transcription deployment on that same resource and its name in `AZURE_TRANSCRIPTION_DEPLOYMENT`. A transcription endpoint on a **different** Azure resource successfully transcribed one locally generated synthetic phrase via multipart upload, but it is **not integrated**. Its deployment name cannot simply be used in the native session configuration; the external-transcription architecture decision remains pending. No resources have been created, deployment names guessed, or input gates bypassed. Integrated live voice input/output guardrails, native microphone/audio, and audible interruption are **not yet verified**. Keep all credentials backend-only in an ignored `.env` with permissions 0600, and rotate any credentials previously shared in chat.

The UI defaults to **Live**, with exact missing settings displayed before microphone controls. Fixture mode remains an explicitly optional synthetic demonstration. Readiness distinguishes configuration presence from prior live verification reports.

## Run locally

Node 20.19+ is required.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The backend binds **127.0.0.1:8787** only. Both ports must be free. Vite proxies `/api` and `/ws`; keep the default API port for `npm run dev`.

For actual voice: configure your Realtime resource/deployment, a transcription deployment on that same resource, and the selected judge as described below. Restart the API, leave **Live** selected, choose Jev or LLM and **Normal agent**, then **Start microphone** and grant browser permission. Ask a Relay billing question aloud. Select **Stress test** on a new call to exercise external-only synthetic output restrictions. Stop before changing configuration. Headphones are recommended.

For the optional offline demonstration, switch to **Fixture**, choose a scenario and **Normal agent** or **Stress test**, then **Play fixture**. Fixture playback uses authored text and scripted UI-event times, **not audio, recordings, real model predictions, or measured latencies**. It never asks for microphone access. The waveform is a decorative activity animation, not an audio meter.

**Replay bench** runs the selected tuning/held-out split through the actual coalescing scheduler. **Compare providers** uses the real configured Jev and LLM services, incurs API costs, and does not require voice/transcription. **Run fixture replay** uses one explicitly labeled fixture-label oracle, never fake Jev/LLM results; provider panels remain "Not measured" for that run. The knowledge inspector contains all synthetic facts and policies.

The most recent completed measured replay reloads from `results/latest-provider-replay.json` when that local file exists. The original workspace's preserved live result is a **two-case smoke comparison** (`input-02`, `output-32`, four provider requests total), not a full benchmark. An attempted 30-case held-out run was aborted by its caller's 180-second deadline and did not produce a completed report. Its underlying delay was not established; do not infer accuracy, coverage, or latency from that attempt. The later two-case request succeeded. The authored 60-case fixture replay completed separately with provider timing fields null. These private artifacts are excluded from the public repository; run your own replay to populate results.

Production-style local serving:

```sh
npm run build
npm start
# http://127.0.0.1:8787
```

The app has no repository creation, publishing, remote deployment, or account-action functionality.

## Secure live configuration

If you already have an authorized `.env`, **edit it in place, do not overwrite it**. For a fresh checkout only, copy the example if no `.env` exists, replace its resource/deployment placeholders, add your own credentials locally, and restart the API:

```sh
test -e .env || cp .env.example .env
chmod 600 .env
```

Never paste keys into chat or browser fields. `.env`, logs, results and build outputs are ignored. No server credentials use a `VITE_` prefix. Do not put real customer data into this demo.

| Variable | Required for | Value |
| --- | --- | --- |
| `AZURE_REALTIME_ENDPOINT` | Voice | `https://YOUR-RESOURCE.cognitiveservices.azure.com/openai/v1/realtime?model=YOUR-REALTIME-DEPLOYMENT`; replace both placeholders with your existing resource and deployment |
| `AZURE_OPENAI_API_KEY` | Voice | Key for that Azure resource, stored server-side |
| `AZURE_TRANSCRIPTION_DEPLOYMENT` | Voice input gates | **Existing Azure-supported transcription deployment name on that resource**; not a guessed model alias |
| `AZURE_VOICE` | Voice, optional | Defaults to `marin` |
| `JEV_API_KEY` | Jev judge | TypeSafe API key |
| `JEV_MODEL` | Jev, optional | Pinned `jev-1.13.0` by default; requested and returned versions are recorded |
| `LLM_BASE_URL` | LLM judge | `https://api.openai.com/v1` or your resource's `https://.../openai/v1` base URL |
| `LLM_MODEL` | LLM judge | A separately provisioned, structured-output-capable model/deployment |
| `LLM_API_KEY` | LLM judge | Key for that independent judge endpoint |
| `LLM_AUTH` | LLM, optional | `bearer` (OpenAI and Azure v1 examples), or `api-key` for Azure |
| `LLM_REASONING_EFFORT` | LLM, optional | Omitted if empty. Only set a value supported by your chosen deployment; e.g. `none` for a model supporting fast non-reasoning mode |
| `LLM_MAX_COMPLETION_TOKENS` | LLM, optional | 1024 by default, including reasoning budget where applicable |

**Do not use the realtime deployment as the LLM judge unless you independently establish that it supports Chat Completions + strict structured output. This app makes no such assumption.** Unsupported effort/model/schema settings are explicit failures, not silently modified requests.

Azure's reference says input transcription uses an **existing deployment name**. Microsoft examples use transcription model families such as `whisper-1` and `gpt-4o-mini-transcribe`; naming one does not create that deployment or establish access. The input transcription side channel supports judging; speech generation still consumes native audio through Realtime, not a transcription -> text LLM -> separate TTS chain.

Live mode requires Azure config plus the selected judge. Measured provider replay needs **both judge configurations**, but does **not** need Azure voice credentials.

## Behavior and lifecycle

### Two voice configurations

The versioned knowledge base and policies are separate (`shared/policies.ts`). Both agents receive the **same facts**, including public prices/support, Project Lantern offline editing and its tentative November 15 launch, concrete retention eligibility/process, and fictional competitors.

- **Normal:** system instructions include the app's output restrictions; the external judge is a backstop.
- **Stress:** only the external judge enforces the synthetic output-content restrictions. Input gates, absence of tools and provider safeguards remain unchanged. It deliberately increases opportunities to demonstrate interception; it is **not evidence of a normal model failure rate**.

The knowledge base contains facts, not embedded "do not disclose/recommend" commands that would accidentally reintroduce normal-mode output enforcement in stress mode.

### Input: gate response creation, not audio ingestion

1. Backend mints an ephemeral Azure client secret with the fixed session config. It sends the browser SDP offer to Azure `/openai/v1/realtime/calls` with that ephemeral token; neither master keys nor the ephemeral token are returned to the browser.
2. Backend reads the call ID from `Location`, attaches the documented Azure observer/controller WebSocket, and confirms `session.updated`.
3. Browser microphone tracks stay disabled until SDP, data channel and backend gate readiness are all confirmed. Server VAD stays on; **both `create_response` and `interrupt_response` are false**. The application explicitly manages interruption. No idle-triggered auto-response is configured.
4. On a final user transcript, the judge evaluates three independent policies with recent context and trusted facts. User speech and context are untrusted fields, never new system instructions.
5. **Allow:** browser acknowledges arming for the current input item; only then can the backend send `response.create`. Native input item references include only approved user turns and completed assistant responses, not stale/rejected user audio.
6. **Violate:** fixed policy-specific redirect. **Uncertain/empty:** fixed clarification. Both use constrained native Realtime recovery (`input: []`, no tools, exact fixed phrase instructions), still output-monitored. Recovery is not prerecorded audio and is not assumed infallible.
7. **Error/timeout/missing transcript:** explicit guardrail-unavailable state; stop the call, microphone and speech. Never silently allow.

New speech invalidates approvals and pending responses using input item IDs, turn generations and request metadata. Duplicate/out-of-order transcriptions cannot revive an old turn. Audio already reached Azure before its transcript is judged: this gate controls **responses**, not ingestion. There are no action tools.

### Output: detect and interrupt

- Accumulate `response.output_audio_transcript.delta` by response/item/content index, respecting final transcript replacements and ignoring deltas after a finalized part.
- Every 200 ms, offer a snapshot **only when text changed**, containing full response-so-far, recent context, trusted knowledge and policies. At most one request is in flight and one pending snapshot is replaceable. Final snapshots flush immediately/after the in-flight request, not after an unbounded queue.
- A pass is **"clear so far"**, not authorization for later words. Generation completion does not end monitoring: a final verdict can still interrupt while playback continues.
- On violation or uncertainty: send a browser mute command immediately, cancel generation if still active, and clear the provider WebRTC output buffer. Track `response.done`, `output_audio_buffer.cleared`, browser mute acknowledgment, and `conversation.item.deleted`.
- After cancellation completes, **delete the entire interrupted assistant item** and confirm deletion before recovery. This conservatively removes even heard parts of an interrupted answer from model context; it does not invent `audio_end_ms` or claim exact transcript/audio truncation. The UI retains the generated transcript for inspection with a not-audio-aligned label.
- Recovery only begins after those confirmations. A failing recovery stops instead of recursively retrying. User barge-in also mutes immediately locally and supersedes stale judgments.
- Sideband/control loss, malformed provider results, transcript loss/stall, missing cleanup confirmations, and timeouts fail closed. "Guardrail unavailable" is **not** counted as a detected violation.

**There is no intentional pre-playback output buffer. Some restricted synthetic speech can be heard before detection, and an entire short response may finish before a verdict. This is not zero leakage.** Realtime transcripts are not guaranteed to arrive before corresponding audio. There is no published fixed transcript/audio delay guarantee used here.

### Operational bounds

One live call or evaluation job at a time per local API. Maximum two provider requests concurrently per provider, 240 requests/minute/provider by default; explicit overload errors, no blind retries. Transcript limit 16,000 characters; judge context last 8 turns; native input references last 8 approved items. Call capped at 40 speech turns. Input transcription timeout 12s; judge timeout 4s by default; missing first output transcript 1.5s after provider playback-start; stalled nonfinal transcript 2.5s; generation/playback lifecycle 45s; cleanup confirmation 6s. These are conservative **prototype settings, not calibrated provider guarantees**.

The browser checks a 2s backend heartbeat and stops after 6.5s without it. Stop closes tracks, remote receivers, peer/data/control connections and the audio context, including when microphone permission resolves after Stop. Auto-reconnection is intentionally absent; start a fresh call after an error.

## Judges and reproducible evaluation

**Jev:** validated HTTP `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>` (verified in the [official SDK source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts)), one independent `choice` question per phase policy. The rendered documentation masks the auth header; sending a raw key without the Bearer scheme returns HTTP 403. Validate `model`, `answers[id].type/choice/probabilities/confidence`, probability sums and winning choices. An explicit winning-probability threshold (`JEV_MIN_PROBABILITY=0.8`) maps low-evidence answers to uncertain. **The default is provisional, not accuracy-calibrated. Jev does not generate explanations and this app attributes none to it.**

**LLM:** `/chat/completions` with the same fixed policy semantics/knowledge and a minimal strict `json_schema` object with one enum per policy. No requested chain-of-thought, no artificial delay, no mandatory reasoning effort. Refusal, invalid JSON, incomplete generation, missing policy keys and invalid decisions are explicit errors.

```sh
npm run eval                       # 60 cases; fixture oracle only
npm run eval -- --tuning            # 30 authored tuning cases
npm run eval -- --providers --held-out  # BOTH real judges; credentials required, incurs API costs
```

`shared/cases.ts` contains 60 concrete, inspectable synthetic cases: 30 input, 30 output; 10 per policy; odd IDs tuning, even IDs held-out. Includes paraphrases, harmless mentions, unfinished clauses, ambiguity and contextual confirmations. **Labels are authored for review, not independently human-validated.** Tune thresholds/prompts on the tuning split only, freeze versions/config, then run held-out. Independent human label review is a prerequisite to performance claims.

Each provider gets its own independent timestamped stream under the same scheduling/timeout settings. The first provider's detection never deprives the other of evidence. Detection does not stop shadow replay. Coalescing can skip different intermediate snapshots for faster/slower providers; final-case coverage is reported, raw checked snapshots/offsets are retained. Do not compare global accuracy blindly when coverage differs.

Results persist as `results/eval-<id>.json` with source, corpus/policy/KB/scheduler versions, settings, requested/resolved models, reasoning configuration, expected/predicted decisions, errors, service times and case-relative verdict offsets. Fixture durations/offsets that might be mistaken for provider measurements are `null`.

Successful provider replays also update `results/latest-provider-replay.json` for read-only reload through `/api/evaluations/latest`. Reloading a report makes no paid requests. Use the source, checked case IDs, sample counts, timestamp and recorded configuration to distinguish a small smoke comparison from a complete held-out evaluation.

Live logs are `results/live-<id>.jsonl`; transcript text is **off by default**, replaced with character counts. `LOG_LIVE_TRANSCRIPTS=true` explicitly opts into local transcripts. UI JSON exports contain visible transcript text. Results are private local files (0600), not uploaded by the app. Protect or delete them as appropriate.

### Metrics

- Input and output judge p50/p95 are separate, server-monotonic HTTP service durations (network + provider + parsing). Sample counts are shown. Missing samples are `--`/`null`, not invented zeros.
- Transcription event delay is speech-stop event receipt -> final transcript receipt on the **same** clock.
- Browser speech-end -> first unmuted remote-stream audio energy over threshold is an **estimate**, not hardware-audible time. It is not part of judge service latency.
- Command-receipt -> browser mute measures local application response, **not** verdict-to-browser network transit or hardware silence. No server/browser timestamps are subtracted.
- First transcript-event minus provider playback-start-event receipt is a signed **event offset**, not semantic phrase alignment.
- False positives mean authored allow -> violate; misses mean authored violate -> allow. Abstentions, unavailable/error decisions, final-case coverage and correct/total scored policy decisions are separate. An unavailable request is not an accuracy success.
- No leaked-word/exposure-duration metric is claimed. Fixture oracle accuracy is tautological and is not displayed as provider performance.

No native audio recordings are supplied. The fixtures are synthetic text/events, not mislabeled Azure recordings. A later captured-audio corpus would need consent, recording provenance, word/phrase alignment or manual audible review, browser monotonic event annotations, expected policy onset and independent labels before supporting exposure metrics.

## Validation

```sh
npm test                 # deterministic engine/scheduler/contracts/replay tests, no paid requests
npm run typecheck
npm run build
npm run verify:azure     # explicitly paid-service transport probe, no mic/inference
npm run verify:jev       # four real Jev requests; credentials required
npm run verify:llm       # four real LLM requests; credentials required
npx playwright install chromium   # once, if the browser is missing
npm run test:ui           # local API + Chromium fixture/replay/mobile/track cleanup
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/readiness
```

Browser cleanup tests use synthetic Web Audio media tracks; they do not establish live microphone hardware or Azure connectivity. A headless environment may not support `getUserMedia` even when WebRTC APIs are available; the app surfaces the DOM exception name and stops.

**Live acceptance still required:** configure a transcription deployment on the Realtime resource, then speak a benign billing question, input-block contrasts and synthetic stress questions. Check cancel/clear/deletion confirmations, user barge-in, final delayed verdicts, audio autoplay permissions and measured error/accuracy coverage. Token/SDP/sideband and four real requests per judge passed in the original setup; full spoken interaction has not. Verification commands persist sanitized reports locally in `results/azure-transport-verification.json`, `results/jev-live-verification.json` and `results/llm-live-verification.json`; these are not committed.

Azure's [data-plane model listing](https://learn.microsoft.com/en-us/rest/api/azureopenai/models/list?view=rest-azureopenai-2024-10-21) is a base/fine-tuned model catalog, not deployment names. [Listing existing deployments](https://learn.microsoft.com/en-us/rest/api/aiservices/accountmanagement/deployments/list?view=rest-aiservices-accountmanagement-2024-10-01) requires management-plane/Entra access and resource identifiers, not just the supplied resource key. No documented built-in transcription bypass was established; no deployment name is guessed and no Azure resources are provisioned.

## Primary contracts consulted (September 24, 2026)

- [Microsoft: Realtime WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc), updated September 23: GA `/openai/v1/realtime/client_secrets` with resource `api-key`, `/calls` with ephemeral bearer token; **Step 3 explicitly documents** Location-derived `call_id` observer/controller at `wss://RESOURCE/openai/v1/realtime?call_id=...`, authenticated with `api-key` or Entra bearer.
- [Microsoft: WebSockets](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets) and [GA migration](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-preview-api-migration-guide): GA paths, nested audio config, new transcript event names, no preview API version/OpenAI-Beta header.
- [Microsoft: Realtime reference](https://learn.microsoft.com/en-us/azure/foundry/openai/realtime-audio-reference): refers to OpenAI Realtime event specification; explicitly calls out Azure transcription deployment names as a deviation.
- [Referenced client events](https://developers.openai.com/api/reference/resources/realtime/client-events) and [server events](https://developers.openai.com/api/reference/resources/realtime/server-events): `response.cancel`, WebRTC `output_audio_buffer.clear`/`cleared`, item deletion/confirmation, response input item references, response metadata and transcript/lifecycle events.
- [Microsoft: Structured outputs](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs): Azure v1 OpenAI-compatible clients and strict schemas.
- TypeSafe [introduction](https://docs.typesafe.ai/introduction), [models](https://docs.typesafe.ai/models), [API](https://docs.typesafe.ai/api), [primitives](https://docs.typesafe.ai/primitives): Jev 1.13.0, typed System One questions and validated Choice responses.

The Azure implementation follows **Azure's documented sideband support**, not an assumption that OpenAI public sideband/GPT-Live APIs transfer to Azure. Browser forwarding of transcripts is not needed in this implementation. No `webrtcfilter=on` is used, because complete lifecycle events are needed for local timing/control checks; prompts/KB are deliberately inspectable synthetic data.

## Limitations and structure

This is a cooperative localhost prototype, **not a production security boundary**. A modified browser can ignore mute controls, alter its own data-channel behavior or capture audio already received. Origin checks, bounded requests and server-held credentials do not make an untrusted client tamper-proof. There is no authentication/multi-tenant storage system, no audio ingestion guardrail, no account data, no tools and no provider-safety bypass.

Judgments are semantic model decisions, not guaranteed policy enforcement. Input transcripts can disagree with what the native voice model heard. Non-English accuracy, model shifts, latency under load, missing/truncated transcript behavior, and actual audible exposure need live measurement. All prices, customers, competitors, confidential product information and policy restrictions are fictional.

```text
shared/       typed protocol, policies/KB, 60 authored cases, metrics
server/       Azure negotiation/sideband, input/output engine, bounded judges,
              coalescing scheduler, replay/CLI, loopback HTTP/WebSocket server
src/          React lab, native browser media/control, labeled fixture playback
tests/        engine, scheduler, contracts, replay, Chromium UI/track cleanup
results/      ignored private local JSON/JSONL run artifacts
```
