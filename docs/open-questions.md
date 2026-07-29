# Open questions

Items still **unverified** or **unknown** in the Serato Remote protocol
specification. Resolved findings live in [`protocol.md`](./protocol.md).

Each entry is labelled `[unverified]` (a strongly-supported hypothesis awaiting
empirical confirmation) or `[unknown]` (no working hypothesis yet).

## Discovery

- **Multiple instances.** When more than one peer is on the network, does each
  publish a distinguishable instance name? The observed format is
  `<AppName> @ <hostname>` (with `@` literal, hostname including `.local`).
  Whether collision is handled by Bonjour's automatic ` (2)` suffix or by
  app-side renaming is **[unknown]**.

## Authorization — RESOLVED (verified live 2026-07-27)

The `Authorize/Response` is an **MD5 challenge-response**, confirmed live by
hooking Serato's own digest and driving a real handshake to a flowing `/Status/`
stream:

```
Authorize/Response = (peerName: s, peerUuid: s, MD5(nonce ‖ secret): b)   // type tag ,ssb
```

`nonce` = the 16-byte Authorize/Request blob (regenerated per connection);
`secret` = either of two 32-byte constants in the binary. Full detail in
[`protocol.md` §3.1.1](./protocol.md). Key corrections vs. earlier drafts:

- **The hash is MD5, not MD4.** MD4/MD5 share the IV, and the MD5 T-table lives
  in `movk` immediates (not searchable `__const` data), so an earlier data-only
  search misread it as MD4. `MD5(nonce ‖ secretA)` reproduces Serato's captured
  digest byte-for-byte.
- **The response is `,ssb`, not `,b`.** The handler reads two strings then a
  blob; a bare blob throws inside oscpack arg iteration before the digest check,
  which is why every earlier blob-only attempt stalled.
- **Pairing:** after a valid digest Serato sends its own `Pair` (isActive=0);
  the remote replies with `Pair(peerName, peerUuid, isActive=1)` to open the
  stream. `StatusChanged` from the remote is not required.
- **Tooling note:** the live hook required a **developer-signed** resign
  (`frida_resign_app mode='developer'`) so Frida can attach without crashing,
  **and** granting that resigned bundle macOS **Local Network** permission (its
  Bonjour browse is otherwise silently denied because TCC keys off the code
  signature). Adhoc resign + Frida attach crashes; adhoc + spawn boots but never
  browses.

Remaining minor items:

- **Request int semantics.** **[unknown]** — the two int32 fields in
  `Authorize/Request` (`,bii`, both observed `1`) are not consumed by the
  digest. Plausible: protocol version, capability flags, peer type.
- **User consent UX.** **[resolved]** No prompt gates pairing; authorization is
  automatic once the digest is correct.
- **Re-authorization.** The nonce is **regenerated per connection**, so the
  digest must be recomputed on every connect — it cannot be cached.

## Pairing

- **Pair direction.** **[unverified]** The boost binding
  `RemoteManagement::method(path, bool, string&, string)` matches the 4-arg
  shape of a Pair _send_ call (`isActive`, `peerName`, `peerUUID`), suggesting
  Serato can send Pair too. Whether Serato sends Pair in response to
  Authorize/Response or expects the remote to send Pair first is the next thing
  to verify.
- **StatusChanged direction.** **[unverified]** Enum values (`Paired`,
  `PairedNotActive`) and shape (`,s`) are confirmed by static analysis, but
  whether the message is sent remote → Serato, Serato → remote, or both, has not
  been verified end-to-end against a successful pairing.
- **Multi-remote behavior.** **[unknown]** What happens if multiple remotes try
  to pair at once?
- **Pair persistence.** **[unknown]** Is pairing one-shot per session or
  persistent across restarts?

## Subscription model

- **Mandatory or filtering?** **[unknown]** Does the desktop withhold status
  updates until the remote subscribes, or does it always emit and
  `/Register/Status/<topic>` is just an opt-in filter?
- **Argument shape.** **[unknown]** Do `/Register/...` paths carry any args —
  e.g. a flag to start vs. stop the subscription, a deck mask?

## Heartbeat

- **Dead-peer timeout.** **[unknown]** No failure scenarios have been captured.
  Testing requires deliberately stopping the heartbeat reply and timing the
  disconnect.

## Status message details

- **`/Status/Deck/Playhead` three floats.** **[resolved — verified live]** They
  are `(positionSeconds, playRate, bpm)`: float 1 is the play rate (`0` stopped,
  `1.0` normal, pitch multiplier when playing) and float 2 is the pitch-adjusted
  BPM (`bpm / playRate` held constant at the base BPM across a pitch sweep).
  There is **no** track-length field. See [`protocol.md` §4.2](./protocol.md).
- **`/Status/Video/Mixer/Crossfader` range.** **[resolved — verified live]**
  `0.0…1.0`, left → right, **not** centered on 0. Confirmed by sweeping a real
  controller to both hard stops: hard left reported a value that read as centre
  once consumed as -1…+1, while hard right read correctly — the signature of a
  0…1 source in a -1…+1 field. Consumers must rescale (`v * 2 - 1`); see
  `emitOscControllerState` in the desktop Serato connector.
- **`/Status/Video/Deck/Mixer/Upfader` range.** **[resolved — verified live]**
  `0.0…1.0`, linear — **no** curve is applied. Confirmed on hardware. This
  matches `ControllerState.channelFader` exactly, so unlike the crossfader it
  needs no rescaling.
- **`/Status/Deck/Loop/BeatLength` value when loop is off.** **[unknown]** Does
  it stay at the last value or get reset to 0?
- **Update rate / throttling.** **[unknown]** Maximum frequency for
  `/Status/Deck/Playhead`? Tied to audio frame rate, screen refresh, or
  something else?
- **`/Status/Deck/Song/Valid` arg shape.** **[unverified]** Suspected type tag
  `,if` with `(deckIndex, validFlag)`; values for "loaded" vs. "not loaded" need
  confirmation.
- **Wire-vs-internal deck indexing.** **[unverified]** Decks are 0-based 0..3
  internally (verified by binary strings); whether the wire protocol uses the
  same indexing is the natural assumption but not yet confirmed end-to-end.

## Path mysteries

- **`Video/` namespace prefix on mixer paths.** **[unverified]** `Upfader` and
  `Crossfader` live under `/Status/Video/...` rather than `/Status/Mixer/...`.
  Likely vestigial naming from when the protocol was extended to cover Serato
  Video. Are there other `/Status/Video/...` paths that haven't been observed?
- **`/Error/` namespace.** **[unverified]** A bare prefix `/Error/` appears in
  the binary at `0x101a44fe3` alongside a `Malformed Error Recieved` log string
  at `0x101a4502d`. Suggests Serato responds to bad messages by sending
  `/Error/<something>`, but suffix paths and arg shapes have not been observed
  live.

## ACI namespace

Serato DJ Pro 3.x exposes three additional path namespaces for its internal
**ACI** (action-channel) messaging system:

```
/Control/ACI/<id>
/Register/Status/ACI/<id>
/Status/ACI/<id>
```

- **What does ACI stand for?** **[unknown]** Likely "Action Channel Interface"
  or "Audio Control Interface". Internal references use lowercase `aci` and a
  `proto_enum_to_aci_map`, suggesting protobuf-style numeric message IDs.
- **Wire format of `<id>`.** **[unknown]** Numeric suffix (`/Status/ACI/42`),
  hierarchical (`/Status/ACI/Deck/1/Playhead`), or something else?
- **Argument schema per ACI message ID.** **[unknown]** Each message has an
  associated data shape that needs to be enumerated.
- **Coexistence with `/Status/Deck/...`.** **[unknown]** Does Serato emit both
  schemes in parallel, or pick one based on peer capability negotiated during
  the Authorize/Pair handshake?
- **`/Control/ACI/<id>` direction.** **[unknown]** This is the only inbound
  _control_ path observed (peer → Serato). Out of scope for read-only consumers
  but useful for any future feature that wants to drive Serato (e.g. trigger a
  hot cue from a stream-deck integration).

## Error handling

- **Malformed-message behavior.** **[unverified]** Static evidence suggests
  Serato logs and continues — the catch-site at `0x101a44feb`
  (`%p readDataCallback: caught osc::MalformedMessageException [...]`) catches
  the parser's exception inside the CocoaAsyncSocket data callback without
  obviously dropping the connection. Whether the silent conn#2 after
  Authorize/Response in the 2026-05-05 capture is a malformed-message rejection
  or a separate state-machine timeout remains **[unverified]** until we capture
  a live `/Error/` reply.
- **Auth/pair failure path.** **[unverified]** Likely sent on the `/Error/`
  namespace, but no `/Error/` traffic has been observed yet. Argument shape
  unknown.
- **Resource limits.** **[unknown]** What happens if the remote subscribes to
  too many topics, or sends messages too fast?

## Versioning

- **Protocol version.** **[unknown]** Is there any version negotiation? The TXT
  record is empty, so any version field would have to live inside the OSC
  handshake (likely the two int32 fields of `/StreamMgmt/Authorize/Request`).
- **Compatibility across Serato DJ versions.** **[unknown]** Has the protocol
  changed between Serato DJ 2.x and 3.x? Are any paths deprecated or new in the
  recent ACI work?
