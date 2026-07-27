# serato-connect documentation

This directory documents the **Serato Remote protocol** — the OSC-over-TCP
protocol that Serato DJ Pro speaks for live deck/track/mixer telemetry over the
local network. `serato-connect` **implements** a client for this protocol
(`SeratoRemoteClient`) so that downstream apps can react to Serato in real time
without polling history files.

## Contents

- **[protocol.md](./protocol.md)** — full protocol specification: transport,
  discovery, connection lifecycle, every known OSC message with argument types
  and semantics.
- **[open-questions.md](./open-questions.md)** — items that are known to be
  unknown: argument meanings yet to be confirmed, edge cases, version
  differences, etc.

## Status

The protocol is **fully reverse-engineered, verified live end-to-end, and
implemented** (Serato DJ Pro 3.3.5.29, 2026-07-27): discovery, the MD5
challenge-response authorization, the mutual Pairing exchange, topic
subscription, and the OSC-bundle `/Status/` stream all work against a live
Serato instance. A few residual details (the meaning of the three `Playhead`
floats; exact fader ranges at the extremes; the `Authorize/Request` int fields)
are still marked **[unverified]**/**[unknown]** inline and tracked in
[open-questions.md](./open-questions.md).

## Scope

The Serato Remote protocol is one of two integration modes for Serato data:

| Mode                   | Source                                                      | Latency          | Coverage                                                    |
| ---------------------- | ----------------------------------------------------------- | ---------------- | ----------------------------------------------------------- |
| File-based             | `~/Music/_Serato_/` (history sessions, database, GEOB tags) | ~2s (mtime poll) | Track loaded, history, library, tags                        |
| **Network (this doc)** | `_SeratoIOSRemote._tcp` Bonjour service                     | sub-frame        | Live playhead, faders, loop state, track changes, beat info |

These modes are complementary, not exclusive — `serato-connect` supports both,
with the network mode preferred when a live Serato DJ Pro instance is
discoverable on the network.
