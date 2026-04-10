# Rhodium — Development Log

---

## 2026-04-09 — RHOD-004: Event Emitter

### Goals
Implement the typed event bus (`EventEmitter`) for `packages/core` — the first runtime implementation in the repo (previously types-only).

### Completed

- **`packages/core/src/events.ts`** — `EventEmitter` class
  - Typed `on<E extends BrokerEvent>()` / `emit<E extends BrokerEvent>()` overloads enforce payload types at compile time
  - Fallback `on(string, handler)` / `emit(string, payload)` overloads for custom plugin-to-plugin events
  - Internal `Map<string, Set<Function>>` — zero dependencies
  - `on()` returns an unsubscribe function; double-unsubscribe is safe

- **`packages/core/src/events.test.ts`** — 11 unit tests (Bun)
  - Typed BrokerEvent subscribe/emit/isolation
  - All 15 `BrokerEvent` types exercised
  - Unsubscribe correctness (stops handler, double-call safe, leaves siblings intact)
  - Custom string events (payload delivery, broker isolation, unsubscribe)

- **`packages/core/src/index.ts`** — added `export * from './events.js'`

### Branch
`feat/rhod-004-event-emitter` — awaiting merge decision (in worktree at `.worktrees/rhod-004-event-emitter`)

### Test Status
11/11 passing, 0 type errors

### Pending
- Merge / PR decision from user

---

## Status: Active
Current focus: RHOD-004 branch ready to merge or PR.
