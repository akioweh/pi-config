# Gemini video analysis

Adds `gemini_video_analysis` and `/gemini-video` without changing Pi's main model or transcript format.
Requires a Google Gemini API key configured through Pi's `/login` or `GEMINI_API_KEY`.

## Setup

Install this extension's dependencies with `npm ci --ignore-scripts --legacy-peer-deps` from this directory, then run `/reload` in Pi.
Pi discovers `index.ts` in the extension directory.

`/gemini-video` opens three tabs: model, thinking level, and media resolution.
Tab/Shift+Tab switches panels; Enter saves the selected value; Escape closes.
Selections are global, stored in `gemini-video.json` under Pi's agent directory, and do not change the main conversation model.
The menu requires interactive TUI mode.

Supported agentic models: Gemini 3.8 Flash (default), 4 Argon, 3.6 Flash, and 3.5 Flash Lite.
Only models available through Pi's direct `google` provider appear.
Thinking choices are restricted to each model's supported levels.
Resolution defaults to the API default; high resolution is useful for dense text in video frames.

## Tool

New analysis:

```json
{
  "prompt": "What changes in the chart? Include timestamps.",
  "videos": [{"type": "local", "path": "recording.mp4"}]
}
```

Paths are relative to Pi's working directory.
Local files must have a supported video extension: `.mp4`, `.mpeg`, `.mpg`, `.mov`, `.avi`, `.flv`, `.webm`, `.wmv`, `.3gp`, or `.3gpp` (case-insensitive).
The extension checks the whole batch before uploading and supplies explicit MIME types; it does not inspect file contents to verify their format.
Other inputs are `{"type":"youtube","url":"https://youtu.be/VIDEO_ID"}` for public YouTube videos and `{"type":"file","uri":"https://generativelanguage.googleapis.com/v1beta/files/FILE_ID"}` for uploaded Gemini files.

The result contains `answer`, `analysis_id`, and reusable uploaded `files` URIs.
Continue with `{"prompt":"Check that chart again.","previous_analysis_id":"ANALYSIS_ID"}`.
Each result has its own handle; continuing an earlier handle creates a separate analyst branch.
Handles are resolved from the active Pi branch and also work when this tool is called through another tool, such as codemode.

Global settings are read for every invocation.
Resolution applies to newly attached video inputs, not retroactively to video already in the analyst's context.
Reuse returned file URIs instead of uploading the same local video again.
Uploads are not cached or fingerprinted.
Gemini files normally expire after 48 hours; stored interactions have separate retention limits.

## Execution and display

The SDK uploads local files, starts a stored background interaction with agentic processing, streams its thought summaries and step notifications, and retrieves the final response.
Escape/abort stops local upload requests and requests cancellation of a running server job.
Upload, stream, and API failures fail the tool call; there is no automatic recovery or static-processing fallback.

The collapsed display uses Pi's loader while running and shows completion and estimated cost afterward.
Pi's usual tool expansion shows the answer, streamed activity, sources, usage, and API response metadata.
Opaque signatures, embedded media data, model settings, and SDK HTTP internals are omitted from diagnostics.
Model-facing results contain neither settings nor diagnostics.

Nested token usage and cost are returned through Pi's tool usage accounting, contributing to the standard footer total (under Tools/summaries in cost breakdowns).
Costs use Pi's model catalog prices and include thinking and agentic tool-use input tokens.
Failed calls do not contribute usage when no tool result with usage is returned.

Videos and analysis prompts are sent to Google.
Background execution requires server-side storage.
The extension neither deletes uploaded files nor stored interactions after successful analysis, allowing follow-ups until they expire.

## Checks

```sh
npm run check
npm test
```

Type checking follows the parent extension directory's local Pi installation layout.
The integration tests use `PI_PACKAGE_DIR` when set, otherwise `/usr/lib/node_modules/pi`; they skip if that installation is unavailable.
Tests use fake credentials and mocked responses, not paid API calls.

API references: [video understanding](https://ai.google.dev/gemini-api/docs/video-understanding), [Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview), [token accounting](https://aistudio.google.com/docs/tokens).
