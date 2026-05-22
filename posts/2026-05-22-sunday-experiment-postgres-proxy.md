---
title: "Sunday experiment: a Postgres proxy in Rust"
date: 2026-05-22
slug: sunday-experiment-postgres-proxy
description: Building a Postgres proxy in Rust over a Sunday. What the wire protocol gives you for free, and where my coding assistant ran out of taste.
---

Recently, I was part of a big (even gigantic) migration to Postgres. Everyone who has done a database migration knows that the hard part isn't the schema or the data, it's the queries. Or more specifically: how developers use the database, and how they make a DBA's life a tiny inch more difficult. Legacy code has habits Postgres doesn't share, and you can't fix all of them before a cutover.

I wanted to dive deeper into Postgres and its internals. So over a Sunday, during a database cutover, I went to see how much of a guardrail I could build in a day: a Postgres proxy that splits reads from writes, multiplexes connections like `pgbouncer`, and gates queries by rule the way PlanetScale's traffic control does. I called it [**sluss**](https://github.com/mekza/sluss), Swedish for canal lock, the chamber that regulates flow between two water levels.

A note on tooling, since I want to be straight about it. I built *sluss* with Claude Code, abused `/goal`, and sent a small swarm of subagents up the rougher cliffs. I have been using LLMs and coding assistants for roughly two years now, for various kinds of work, coding and not. One of the biggest perks of working at AWS is access to a lot of models and a lot of tokens. Throughout those years I have watched the models evolve and the assistant experience constantly raise the bar. I am not going to attribute this work to Claude Code itself; we are at a point where picking your coding assistant or your model is pretty much like Vim vs Emacs, T-shirt vs shirt, ergo it's down to taste. The point is that "in a day" used to mean a different thing; that is the context this experiment lives in. Everything below is what I learned about Postgres along the way.

## Bite into the bytes

When you are building something that will end up in the data path you want to add as little overhead as possible. The first decision was the most important: do not put `tokio-postgres` (or any Postgres client library) in the data path. Not that those libs are slow but they are full-fledged and I don't need that. The proxy stays on raw bytes from the moment a client connects. Postgres's [wire protocol v3](https://www.postgresql.org/docs/current/protocol.html) is mostly framing. Every message after startup is `[tag(1)][length(4)][payload]` ([message format reference](https://www.postgresql.org/docs/current/protocol-message-formats.html)), and once you commit to forwarding bytes verbatim, you stop caring about the long tail of message types you'd otherwise have to model. `Bind`, `Execute`, `Sync`, `CopyData`, `Describe`, all of it flows through unparsed. The proxy only inspects the messages it has to: `Query` and `Parse` to extract SQL for routing decisions; `ReadyForQuery` to learn the backend's transaction status (`I` idle, `T` in-transaction, `E` failed). That's enough to do everything else.

This pays off in surprising places. Auth, for instance: the proxy authenticates to backends with [SCRAM-SHA-256](https://www.postgresql.org/docs/current/sasl-authentication.html) over TLS (RDS PG14+ defaults to it), but on the client side it answers `AuthenticationOk` immediately and trusts whatever identity the startup message declared. That's controversial-sounding until you remember that a sidecar proxy inside a private VPC isn't doing access control, it's enforcing policy on identity the application has already proven somewhere else. Keeping client-side auth out of the byte path means the proxy can't be a credential exfiltration risk by design.

## Read/write splitting and the transaction trap

Splitting `SELECT` from `INSERT` is easy regex-and-classifier work. Doing it without breaking transactions is where most proxies cheat.

The trap looks like this. A client sends `BEGIN`, then a `SELECT`, then an `UPDATE`, then `COMMIT`. If you naïvely route each statement by classification, the `SELECT` lands on a replica and the `UPDATE` on primary, the `BEGIN` is on neither, the `COMMIT` is on the wrong one, and the world catches fire. The fix is to track the backend's transaction status from `ReadyForQuery`'s status byte and refuse to switch backends mid-transaction. `BEGIN` flips the byte to `T`; the next `SELECT` ignores its classification and stays pinned. `COMMIT` flips it back to `I` and the next routing decision is free again.

This is the kind of thing where the wire protocol does the work for you if you let it. The status byte is the source of truth. You don't need to parse `BEGIN`/`COMMIT` yourself; just watch what comes back from the backend.

## Connection multiplexing

Session-mode pooling is what most apps run today: one client connection pins one backend connection for life. It's wasteful when you have ten thousand mostly-idle clients and a database that gets nervous past five thousand connections. `pgbouncer`'s transaction-mode pooling solves this by releasing the backend on every txn-idle `ReadyForQuery` so other clients can borrow it.

I built the same thing, with one wrinkle: a small set of commands have to *pin* the session permanently. `SET timezone = 'UTC'`, `LISTEN ch`, `PREPARE foo AS ...`, an open cursor, these all leave state on the backend connection that the next borrower would inherit. So *sluss*'s classifier flags any session-state command (`SET`, `LISTEN`, `PREPARE`, cursor commands, the rest) and any `Parse` with a non-empty statement name, and refuses to release the backend after that point. The session is "tainted"; it owns its backend until the client disconnects.

Pool capacity is enforced with a `tokio::sync::Semaphore`. Each backend connection holds an `OwnedSemaphorePermit`; release drops the permit, freeing the slot for the next waiter. Acquire blocks when the pool is full instead of unbounded-allocating new connections. This is the difference between "proxy degrades gracefully under load" and "proxy crashes the database with too many connections."

## Rules at the door

*Sluss* has a small rule engine that sits in front of every query. A rule is a match clause (any combination of user, `application_name`, client IP prefix, regex against the raw SQL or against a literal-stripped fingerprint, or query class like `read` / `write` / `transaction`) and an action: `allow`, `deny`, `observe`, `route_primary`, `route_replica`, `rate_limit`, or `kill_after_ms`.

The reason this matters more at the proxy than anywhere else is the migration story I started this post with. When you are moving a fifteen-year-old codebase off Oracle, the place you cannot fix the queries is the codebase. There are too many of them, owned by too many teams, half of them were last touched by people who left in 2019. What you *can* do is sit a piece of code between the application and the database, count which queries would have been blocked by a rule you haven't enforced yet, hand that list back to the teams that own them, and only flip enforce-mode on once the counters are quiet. That is the loop. Statement-timeout GUCs do the killing, sure, but they do not give you the dry-run, the fingerprint, the per-team breakdown, or the "I deployed this rule without restarting Postgres" property.

Some examples to make this concrete:

```yaml
traffic_control:
  default_action: "allow"
  rules:
    # Catch the legacy code that still writes Oracle-flavored SQL.
    # Don't break it yet, just count.
    - name: "observe_oracle_dual"
      priority: 100
      observe_only: true
      match:
        query_regex: '(?i)\bfrom\s+dual\b'
      action: "deny"
      message: "FROM DUAL is not portable; remove the FROM clause"

    # Defense in depth: refuse to run a DELETE without WHERE.
    - name: "block_unbounded_delete"
      priority: 1000
      match:
        query_regex: '(?is)^\s*delete\s+from\s+\w+\s*;?\s*$'
      action: "deny"
      message: "unbounded DELETE blocked by sluss"

    # The BI tool likes to leave 30-minute table scans running.
    - name: "kill_runaway_analytics"
      priority: 50
      match:
        application_name: "metabase"
      action: "kill_after_ms"
      timeout_ms: 30000

    # The legacy ERP doesn't know how to back off. We do.
    - name: "rate_limit_legacy_erp"
      priority: 10
      match:
        application_name: "legacy-erp"
      action: "rate_limit"
      rate_per_sec: 200
```

Higher `priority` wins. `observe_only` makes any rule a dry-run without changing its action, so a `deny` can sit in counter-only mode for a week and flip to enforce once it's quiet. The whole ruleset is hot-swappable: `POST /rules` with a new YAML body and an `arc-swap` pointer flip moves the new set into place atomically. In-flight queries finish under the old rules, the next one runs under the new ones, no restart, no quiesce.

`kill_after_ms` deserves a footnote because the obvious implementation is wrong. Closing the backend socket stops the proxy from waiting for a response, but it does not stop the query: Postgres notices the broken connection eventually and rolls back, after the expensive work has already happened. The right thing is what `psql` does when you press Ctrl-C, send a [`CancelRequest`](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS) on a *different* TCP connection carrying the original session's `(pid, secret)` pair, and let the server use that pair to find the running backend and signal it. So *sluss* tracks both pid/secret pairs (the one it issued to the client, and the real backend's) and when a kill rule fires it opens a fresh TCP to the right backend host and forwards a real cancel packet. In one of the tests I ran on RDS, `pg_sleep(10)` got cancelled in 1.93 s and the response was Postgres's own "canceling statement due to user request", proof that the cancel landed on the server, not on a socket somewhere.

The Postgres connection isn't the natural place to enforce this. Postgres has statement timeouts and you can `pg_terminate_backend` the offender, but you can't easily say "this regex, on this application name, route to a replica instead of primary, and oh by the way let me see how often it would have fired before I turn it on." A small piece of policy code one hop in front of the database is the natural place.

## LSN-aware read-after-write

The post-write replica lag problem has two textbook solutions. The wrong one is: a wall-clock window. After any write, route reads to primary for *N* milliseconds. Pick *N* too small and users see stale data. Pick it too large and primary takes traffic that didn't need to. Either way, you don't have a guarantee, you have a probability distribution.

The right one is to use Postgres's [WAL log sequence number](https://www.postgresql.org/docs/current/datatype-pg-lsn.html). Every WAL byte has a unique 64-bit position. [`pg_current_wal_lsn()`](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-BACKUP) reports the primary's current write position; [`pg_last_wal_replay_lsn()`](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-RECOVERY-INFO) reports how far each replica has caught up. If primary is at LSN `X` and your write committed at LSN `X-1`, then any replica reporting `≥ X` has unambiguously seen your write.

*Sluss* does this. After every write commit it captures the primary's LSN with a single extra round-trip and stashes it on the session. A background task per replica polls the replay LSN every 50 ms into an `AtomicU64` (CAS-monotonic; never decreases). When the same session asks for a read, the routing layer consults the per-replica tracker and only picks one whose LSN has caught up. If none has, it waits briefly, bounded by `lsn_wait_max_ms`, then falls back to primary.

In the live test against RDS with a deliberately slow tracker (poll every 200 ms, wait at most 50 ms for catch-up), 100 same-session write-read pairs produced 207 LSN captures, 25 routes-after-wait, 75 fallbacks to primary, and **zero stale reads**. Every read either hit a caught-up replica or correctly hit primary because the replica wasn't ready. PlanetScale calls their version Boost; the trick has been textbook for a while.

The current implementation has a real limit: the captured LSN lives on the `ClientSession`, so a write in session A doesn't help a read in session B. Cross-session causal consistency needs an affinity cookie keyed by user/app/something, and that's a bigger design conversation than a Sunday afternoon.

## tps, TPS, T-P-S!

I spawned `db.r8gd.48xlarge` instances on RDS and Aurora (192 vCPU each) and pointed sixteen `c7i.4xlarge` boxes running `pgbench` at one `c7i.8xlarge` running *sluss*. **Four thousand and ninety-six concurrent client connections funneled through five hundred and twelve backend connections.**

|  | RDS | Aurora |
|---|---:|---:|
| Aggregate TPS (`pgbench -S`) | 255,235 | 239,861 |
| Backend connections | 512 | 512 |
| Multiplexing ratio | 8× | 8× |
| Total transactions in 180 s | 45.86 M | 43.11 M |
| `pool_exhausted` / `backend_errors` | 0 / 0 | 0 / 0 |
| `acquires == releases` | 45.86M / 45.86M | 43.11M / 43.11M |
| Proxy-observed p50 / p95 / p99 | 1.8 / 3.2 / 4.0 ms | 1.9 / 3.3 / 4.5 ms |

RDS edged Aurora by ~6 % on this read-only TPC-B, expected, since the working set fits in buffer cache where Aurora's network-attached storage has nothing to prove. The proxy itself never saturated; CPU sat at ~12 % on a 32-core box.

The number that matters most isn't the throughput. It's that `pgproxy_backend_acquires_total` and `pgproxy_backend_releases_total` agreed to the integer across 45 million queries. Multiplexing is the kind of code that works for 10 minutes and falls apart at hour 4 because of a permit you forgot to release on some path you didn't plan for. Lock-free counters are cheap; spending them on invariants you can't visually inspect catches the kind of bug that would otherwise ship.

## What's still rough

LSN tracking is per-session, as I said. Prepared statements in transaction mode get pinned rather than rewritten (`pgbouncer` 1.21+ does that; *sluss* doesn't), which means heavily-prepared workloads won't multiplex. I've never run it for 24 hours straight under load. There's no failover detection when an RDS endpoint flips. `tokio::time::interval` fires its first tick immediately, so the health-check loop was hammering pools the instant they warmed until I switched to `interval_at(now + interval, interval)`.

## Don't make your agents dumb

The most interesting bug along the way wasn't really *my* bug, it was Claude Code's, and it points at something that matters about working with these tools. To aggregate `pgbench` results from sixteen loadgen instances, the agent reached for the obvious thing: SSH into each box, `cat /tmp/pgb.log`, parse locally. `pgbench -P` writes a sea of stderr, ~800 MB per box, and I was on slow Hungarian hotel WiFi. I was the bad tenant in your network you don't want, sucking up all of the bandwidth, sorry to my neighbours.

In retrospect the right approach was clear: `grep` the summary lines on the remote box and only pull the matched bytes back. The agent wasn't wrong to want the data, it just had no taste for *where* the work should run. That kind of taste is exactly what `CLAUDE.md`, skill files, and a careful prompt are for: telling the agent up front "when aggregating across many remote hosts, prefer remote-side filtering, never `cat` a log file you haven't checked the size of first." A coding assistant gives you leverage, not judgement. Without the habits you've already paid for the hard way written down, you get a fast intern who has never been on call.

## Closing the gate

You can build a surprising amount of Postgres proxy in a day if you keep raw bytes in the hot path and trust the wire protocol to be mostly framing. Postgres makes this generous: the protocol is well-documented, the `ReadyForQuery` status byte gives you transaction state for free, and the LSN gives you a monotonic clock for replication consistency. The hard parts (SCRAM, real cancel, multiplexing safety) are mostly small amounts of careful code, not large amounts of clever code.

This project is not likely to see production any day, but it was a _fun_ experiment.

[github.com/mekza/sluss](https://github.com/mekza/sluss), if you want to read the bytes yourself.
