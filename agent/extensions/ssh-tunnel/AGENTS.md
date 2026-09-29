## Stylistic guidelines

- (in user-facing surfaces, like UX and README) prefer "SSH-forwarding"/"forwarded" over "remote" for clarity
  - in particular, do not use "remote session" and similar phrases to describe sessions with SSH-forwarding enabled
  - e.g., "SSH-forwarded session" instead of "remote session"
  - e.g., "SSH-forwarding" instead of "remote connection"
  - may use "remote"/"remote host" to refer to the remote SSH host
- Keep README's Design section declarative and high-level. Implementation Details describes mechanisms briefly;
  test commands and compatibility guidance belong here, not in README.

## Resource publication

- Producer adapters live in `core/publication/`; `Resources` owns staging and layout, and `Remote` owns SSH transfer.
  Transfer a directory or bundle in one SSH command, regardless of file count. Publish related resources together
  so relative links work, without rewriting document contents.
- Stage only regular files and directories. Internal symlinks are copied by value; reject escaping links and cycles
  before transferring. Preserve file permission bits, including executability, inside private directories.
- Use public lifecycle/result hooks and virtual-module exports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`);
  never import private Pi subpaths. Check codemode and MCP label formats when updating Pi.
- Preserve Pi's native output sanitization, truncation, and cancellation. Use authoritative `details.fullOutputPath`
  (including progress metadata for thrown errors), never filename guessing or local-read fallbacks.
  Third-party artifact formats without this metadata need a producer adapter.
- Publication errors must abort, redact unpublished results, and latch until reload, even if a nested script catches
  the error. Ordinary user cancellation must not latch a failure.
- Compose with an existing CustomEditor-compatible editor. File and image attachments share path formatting,
  including shell quoting in `!` mode; plain pasted text remains unchanged.
- Copies do not sync back. Temp cleanup may invalidate old paths; skill dependencies and executable temp storage
  are the remote host's responsibility.

## Verification

Run from the repository root against installed Pi:

```sh
for test in check publication clipboard codemode mcp; do
  node --experimental-strip-types "agent/extensions/ssh-tunnel/tests/$test.ts" || exit
done
```

Fixtures simulate SSH locally and use a scripted model; no SSH server, provider network, or desktop clipboard is needed.
They require local `tar`. `PI_CHECKOUT` selects a source checkout when run with its
`src/experimental/source-resolver.ts` loader (see `tests/runtime.ts`).
