# Report an RFC failure — reduce it safely, then file it

Your `open-rfc` call fails against your own SAP system. This walks an agent
through turning that into something a maintainer can act on **without any of
your SAP data leaving your machine**.

Works for Claude (`/report-rfc-failure`) and for any other agent — point it at
this file: `follow .claude/commands/report-rfc-failure.md`. Nothing here depends
on which one runs it.

You do not need a checkout of this repository to use this. You need your failing
code, your error, and the ability to run a script against your system.

---

## The one rule that overrides everything

**Nothing that identifies your system, your users, or your business data leaves
your machine.** Not in the issue, not in a log excerpt, not in a stack trace, not
in a "just this once" paste.

This is not politeness. RFC failures are shaped by the exact function interface,
so the temptation to paste the real thing is strong and the real thing is exactly
what you must not send.

| You will be tempted to paste | Send this instead |
|---|---|
| hostname, IP, instance number, SID, client | the release family only: "S/4HANA 2023" |
| the RFC user | nothing — it is never relevant |
| the real function module name | an invented name, unless it is a standard SAP RFM like `RFC_PING` or `STFC_CONNECTION` |
| real parameter and field names | invented names — `ZFIELD_A`, `ZTAB` |
| returned rows or business values | the ABAP type and length: `CHAR(10)`, `DEC(15,2)`, `DATS` |
| a raw trace, packet capture, or `.env` | the public error group and code |
| a full stack trace | the error class and message, with paths trimmed |

If you cannot describe the failure without one of the left-hand items, say so in
the issue and ask how to proceed. **A maintainer will never ask you for them in a
public issue.** For a suspected vulnerability, use a private security advisory
instead of an issue.

---

## Phase 0 — is this inside the supported boundary?

Do this first. It is the single most common reason a report cannot be acted on,
and it is answerable in two minutes.

Read [`SUPPORT.md`](../../SUPPORT.md) and the
[release status](https://marianfoo.github.io/open-rfc/status/), then establish:

1. **Version.** `npm ls open-rfc`. Support applies only to an exact published
   release, not a local checkout or a packed tarball.
2. **Platform.** Node.js `^22.14.0` or `^24.0.0`. Ubuntu 24.04 x64 is the
   qualified platform — other platforms are expected to work but are not
   release claims.
3. **SAP release.** S/4HANA 2023 and NetWeaver 7.50 are the qualified families.
4. **Route.** Direct application server with password authentication is the beta
   subset. Message server, SAProuter, and the BTP Connectivity SOCKS5 route are
   **previews outside the support contract**.
5. **Capability.** WebSocket RFC, SNC, X.509, principal propagation, registered
   server mode, tRFC/qRFC/bgRFC, non-Unicode and MDMP, and basXML are
   deliberately closed, not missing.

**State plainly which of these your case is outside, if any.** Being outside the
boundary does not make the report worthless — a defect on a preview route is
still worth knowing about, and a closed capability is a feature request rather
than a bug. It changes which template to use and what to expect, so say it
up front rather than letting a maintainer discover it.

If the failure is a *refusal* — the library declining an option or a route — read
the error before calling it a bug. This project fails closed on purpose: a
refused unsupported option is the design working, not breaking.

---

## Phase 1 — capture the failure safely

Get the **public error group and code**, the failure point, and nothing else.

Wrap the failing call so the error's class and code are printed but its content
is not:

```js
try {
  await client.call("YOUR_RFM", { /* ... */ });
} catch (error) {
  console.error({
    name: error?.name,
    code: error?.code,
    group: error?.group,
    // message may embed field paths; read it yourself before sharing it
    message: error?.message,
  });
}
```

Then record **when** it failed, because it decides whether a retry would have
been safe:

- before sending anything
- after a complete send — the system may have executed the call
- unknown or partial send
- not applicable

Read the message yourself before it goes anywhere. If it embeds a field path or
a value, rewrite it with the invented names you will use in Phase 2 and say you
did.

---

## Phase 2 — reduce it to something synthetic

This is the work, and it is what makes a report actionable.

**Find the smallest interface shape that still fails.** Not the smallest program
— the smallest *parameter shape*. Work down from your real call:

1. Does `RFC_PING` succeed? If not, the problem is connection or logon, and the
   interface does not matter — stop reducing and say so.
2. Does `STFC_CONNECTION` succeed? That proves metadata lookup, a scalar send and
   a scalar receive.
3. Remove parameters from your failing call one at a time until it succeeds. The
   last one you removed is the coordinate.
4. Replace every name with an invented one and every value with a synthetic value
   of the **same ABAP type and length**. The type is what matters; the content
   never does.

The result should read like this — real types, no real anything else:

```
IMPORTING  ZFIELD_A  CHAR(10)
           ZFIELD_B  DEC(15,2)
TABLES     ZTAB      3 fields (CHAR(4), DEC(15,2), DATS), ~200 rows
Fails on:  ZFIELD_B when the value has more than 2 decimal places
Succeeds:  same call with ZFIELD_B removed
```

If the failure needs a specific *value* rather than a shape — a particular
length, a boundary, an encoding — say which property of the value matters, and
give a synthetic value with that property. "Fails when the string is exactly 256
characters" is precise and leaks nothing.

**If you cannot reproduce it with invented names**, that is itself a finding:
say so, and describe the difference between the shape that fails and the one that
does not. Do not resolve the difficulty by sending the real thing.

---

## Phase 3 — decide what you actually have

State it in one sentence, and pick one:

1. **Configuration or environment** — wrong parameters, a route that is not
   reachable, a missing authorization. Not a bug. Worth asking about, but say
   that is what you think it is.
2. **Outside the boundary** — a closed capability or an unqualified platform.
   Use the feature template, or file a bug clearly labelled as being on a preview
   route.
3. **A defect inside the boundary** — it should work per `SUPPORT.md` and it does
   not. This is the case the bug template is for.
4. **Unclear** — you have reduced it as far as you safely can and still cannot
   tell. File it and say exactly that, with what you tried. This is a legitimate
   outcome and better than a confident wrong diagnosis.

---

## Phase 4 — write the issue

Produce exactly the fields the
[bug template](https://github.com/marianfoo/open-rfc/issues/new?template=bug.yml)
asks for. Fill every one from what you established above:

- **open-rfc version** — from `npm ls open-rfc`
- **Node.js version, OS, architecture**
- **Consumer shape** — standalone `open-rfc`, the `node-rfc` API, or `@sap/cds-rfc`
- **Generic backend profile** — the release family only
- **Route**
- **Function interface shape** — the invented-name shape from Phase 2
- **Failure point** — from Phase 1
- **Expected and actual behavior** — with the public error group and code
- **Synthetic reproducer** — runnable, with no real names or values

Before you submit, re-read the whole thing against the table at the top of this
file. Check every field, not just the reproducer — a hostname hides more easily
in "expected and actual behavior" than in code.

Then tick the redaction checkbox honestly. If you cannot, do not submit yet.

---

## Phase 5 — fixing it yourself, optionally

If you want to go further than reporting, the maintainer's own workflow is in
[`deep-bug.md`](deep-bug.md). It picks up roughly where this leaves off: it
assumes a checkout, and it will have you write a property test over the full
legal range of whatever varied, control-test that the test fails without the fix,
and open a pull request.

One thing to carry across: this project's recurring defect is
[a decoder that memorises what one system happened to send](../../docs/recurring-bug-class.md)
— a length, a count, or a value range pinned as a literal when it actually varies
by peer, release, or configuration. Six instances so far. If your failure looks
like "works on someone else's system", read that first; there is a good chance
you have found the seventh.

---

## What not to do

- **Do not retry an uncertain call to see if it happens again.** If the call may
  have reached the system, a retry may execute it twice. This matters most for
  anything that writes.
- **Do not repeat a failed logon in a loop.** Failed authentications count toward
  locking a real account.
- **Do not test against production.** Use a non-production system and a
  read-only function module for the first attempt.
- **Do not widen a bound in your own copy to make the error go away** and report
  that as a fix. A fail-closed refusal is usually load-bearing.
- **Do not paste anything from the left-hand column of the table above**, however
  much faster it would make the report.
