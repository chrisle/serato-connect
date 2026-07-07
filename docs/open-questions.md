# Open questions

Items still **unverified** or **unknown** in the Serato Remote protocol
specification. Resolved findings live in [`protocol.md`](./protocol.md).

Each entry is labelled `[unverified]` (a strongly-supported hypothesis
awaiting empirical confirmation) or `[unknown]` (no working hypothesis
yet).

## Discovery

- **Multiple instances.** When more than one peer is on the network,
  does each publish a distinguishable instance name? The observed
  format is `<AppName> @ <hostname>` (with `@` literal, hostname
  including `.local`). Whether collision is handled by Bonjour's
  automatic ` (2)` suffix or by app-side renaming is **[unknown]**.

## Authorization

- **Authorize/Response shape.** **[unverified]** Best-supported
  hypothesis: response mirrors the request shape (`,bii` echoing the
  request's blob plus 2 int32 status flags). Both the argless variant
  and the `,bii` mirror with `(blob, 1, 1)` were tested in the
  2026-05-05 capture; neither advanced the handshake (Serato received
  the response then went silent on conn#2 within ~313 s). Still in
  play:
    - The int values must be specific status codes — e.g. `0,0` for
      "ok" rather than `1,1`.
    - The blob must be transformed (signed/derived) rather than echoed
      verbatim.
    - The shape is correct but a follow-up message must arrive within
      a tight window.
  Format-string evidence is **neutral** — Serato uses adjacent
  printf-style format strings only for `Authorize/Request` (`%b%i%i`)
  and `Pair` (`%s%s%i`); other outbound messages use a typed/templated
  builder API with no `%`-format trace, so the absence of a format
  string adjacent to `Authorize/Response` doesn't prove anything by
  itself.
- **Authorize/Response int semantics.** **[unknown]** — what do the
  two int32 fields mean? Plausible candidates: protocol version,
  capability flags, peer type, error code.
- **User consent UX.** **[unverified]** No prompt was observed when
  Serato connected to the unpaired remote in the 2026-05-05 capture.
  Authorization appears automatic on first connection; whether there
  is a Serato-side preference toggle that gates this is unconfirmed.
- **Re-authorization.** **[unknown]** Depends on whether the session
  blob is regenerated each connection or stored client-side.

## Pairing

- **Pair direction.** **[unverified]** The boost binding
  `RemoteManagement::method(path, bool, string&, string)` matches the
  4-arg shape of a Pair *send* call (`isActive`, `peerName`,
  `peerUUID`), suggesting Serato can send Pair too. Whether Serato
  sends Pair in response to Authorize/Response or expects the remote
  to send Pair first is the next thing to verify.
- **StatusChanged direction.** **[unverified]** Enum values (`Paired`,
  `PairedNotActive`) and shape (`,s`) are confirmed by static
  analysis, but whether the message is sent remote → Serato,
  Serato → remote, or both, has not been verified end-to-end against
  a successful pairing.
- **Multi-remote behavior.** **[unknown]** What happens if multiple
  remotes try to pair at once?
- **Pair persistence.** **[unknown]** Is pairing one-shot per session
  or persistent across restarts?

## Subscription model

- **Mandatory or filtering?** **[unknown]** Does the desktop withhold
  status updates until the remote subscribes, or does it always emit
  and `/Register/Status/<topic>` is just an opt-in filter?
- **Argument shape.** **[unknown]** Do `/Register/...` paths carry any
  args — e.g. a flag to start vs. stop the subscription, a deck mask?

## Heartbeat

- **Dead-peer timeout.** **[unknown]** No failure scenarios have been
  captured. Testing requires deliberately stopping the heartbeat
  reply and timing the disconnect.

## Status message details

- **`/Status/Deck/Playhead` three floats.** **[unverified]** Best
  candidates, in order of likelihood:
    1. `(positionSeconds, lengthSeconds, bpm)`
    2. `(positionSeconds, lengthSeconds, playRate)` — where playRate
       ≠ 1 at non-zero pitch.
    3. `(positionBeats, beatPhase, bpm)` — beat-aligned alternative.
  Disambiguate by loading a known-length track, scrubbing to a known
  position, and varying the pitch fader.
- **`/Status/Video/Mixer/Crossfader` range.** **[unverified]** Either
  -1.0…+1.0 (centered) or 0.0…1.0 (left → right). Determine by
  capturing the value at hard-left, center, and hard-right positions.
- **`/Status/Video/Deck/Mixer/Upfader` range.** **[unverified]**
  Almost certainly 0.0…1.0, but unconfirmed. Are non-linear curves
  applied?
- **`/Status/Deck/Loop/BeatLength` value when loop is off.**
  **[unknown]** Does it stay at the last value or get reset to 0?
- **Update rate / throttling.** **[unknown]** Maximum frequency for
  `/Status/Deck/Playhead`? Tied to audio frame rate, screen refresh,
  or something else?
- **`/Status/Deck/Song/Valid` arg shape.** **[unverified]** Suspected
  type tag `,if` with `(deckIndex, validFlag)`; values for "loaded"
  vs. "not loaded" need confirmation.
- **Wire-vs-internal deck indexing.** **[unverified]** Decks are
  0-based 0..3 internally (verified by binary strings); whether the
  wire protocol uses the same indexing is the natural assumption but
  not yet confirmed end-to-end.

## Path mysteries

- **`Video/` namespace prefix on mixer paths.** **[unverified]**
  `Upfader` and `Crossfader` live under `/Status/Video/...` rather
  than `/Status/Mixer/...`. Likely vestigial naming from when the
  protocol was extended to cover Serato Video. Are there other
  `/Status/Video/...` paths that haven't been observed?
- **`/Error/` namespace.** **[unverified]** A bare prefix `/Error/`
  appears in the binary at `0x101a44fe3` alongside a
  `Malformed Error Recieved` log string at `0x101a4502d`. Suggests
  Serato responds to bad messages by sending `/Error/<something>`,
  but suffix paths and arg shapes have not been observed live.

## ACI namespace

Serato DJ Pro 3.x exposes three additional path namespaces for its
internal **ACI** (action-channel) messaging system:

```
/Control/ACI/<id>
/Register/Status/ACI/<id>
/Status/ACI/<id>
```

- **What does ACI stand for?** **[unknown]** Likely "Action Channel
  Interface" or "Audio Control Interface". Internal references use
  lowercase `aci` and a `proto_enum_to_aci_map`, suggesting
  protobuf-style numeric message IDs.
- **Wire format of `<id>`.** **[unknown]** Numeric suffix
  (`/Status/ACI/42`), hierarchical (`/Status/ACI/Deck/1/Playhead`),
  or something else?
- **Argument schema per ACI message ID.** **[unknown]** Each message
  has an associated data shape that needs to be enumerated.
- **Coexistence with `/Status/Deck/...`.** **[unknown]** Does Serato
  emit both schemes in parallel, or pick one based on peer capability
  negotiated during the Authorize/Pair handshake?
- **`/Control/ACI/<id>` direction.** **[unknown]** This is the only
  inbound *control* path observed (peer → Serato). Out of scope for
  read-only consumers but useful for any future feature that wants
  to drive Serato (e.g. trigger a hot cue from a stream-deck
  integration).

## Error handling

- **Malformed-message behavior.** **[unverified]** Static evidence
  suggests Serato logs and continues — the catch-site at
  `0x101a44feb` (`%p readDataCallback: caught
  osc::MalformedMessageException [...]`) catches the parser's
  exception inside the CocoaAsyncSocket data callback without
  obviously dropping the connection. Whether the silent conn#2 after
  Authorize/Response in the 2026-05-05 capture is a malformed-message
  rejection or a separate state-machine timeout remains
  **[unverified]** until we capture a live `/Error/` reply.
- **Auth/pair failure path.** **[unverified]** Likely sent on the
  `/Error/` namespace, but no `/Error/` traffic has been observed
  yet. Argument shape unknown.
- **Resource limits.** **[unknown]** What happens if the remote
  subscribes to too many topics, or sends messages too fast?

## Versioning

- **Protocol version.** **[unknown]** Is there any version
  negotiation? The TXT record is empty, so any version field would
  have to live inside the OSC handshake (likely the two int32 fields
  of `/StreamMgmt/Authorize/Request`).
- **Compatibility across Serato DJ versions.** **[unknown]** Has the
  protocol changed between Serato DJ 2.x and 3.x? Are any paths
  deprecated or new in the recent ACI work?
