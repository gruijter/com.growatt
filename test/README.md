# Offline test suite

Runs the app's real code — the API client's cache and rate limiter, the capability mapping, the
poll scheduler — against **captured API responses**, with no network and no credentials.

```bash
node test/run.js            # everything
node test/run.js mapping    # one case file, matched by substring
```

Exit code is non-zero if anything fails, so it drops straight into CI or a pre-commit hook.

## How it works

`zzz_collect.js` captures live responses into `zzz_responses/`. `test/fixtures.js` installs a
`fetch` stub that replays them, matched on the same `(endpoint, parameters)` pair that Growatt
keys its own rate limit on. Nothing else is mocked: a test drives `growatt_api.js` exactly as the
app does, so a change that breaks parsing, caching or limiting fails here.

A client is built with a token of `fixture:<account>`, so **no real credential appears anywhere in
the suite**. A real token also works — it is matched by hash — which lets the same harness be
pointed at the live API to check whether a fixture has gone stale.

`GrowattClient.__testHooks` (`reset()`, `setSpacing(ms)`) exists only for this: it clears state
between runs and drops the 3-second politeness delay, which protects a live server and has nothing
to protect here. The app itself never calls it.

## Local only, and never shipped

`zzz_responses/` is in `.gitignore`: the fixtures hold serial numbers, plant names and
coordinates. The test code is tracked, and `test/` is in `.homeyignore`, so none of it reaches the
published app bundle.

**Every case that needs fixtures skips instead of failing when they are absent**, so the suite still
runs if the archive is cleared or captured on another machine.

Recapture with `node zzz_collect.js` (~4 minutes; it spends one of the ten daily
`user_plant_list` calls per account, see `zzz_docs/API-FIELD-NOTES.md` §11).

A user's diagnostics report works too: `lib/growattCapture.js` logs each read request's answer once
per app start, device init, pairing and repair, with location and contact details redacted.
`node test/from-logs.js <report.txt> --account <name>` writes those into `zzz_responses/<name>/`
under the same names and index entries as `zzz_collect.js` (`--dry` to look first, `--force` to
overwrite).

## The cases

| File | What it protects |
| --- | --- |
| `replay.js` | That the archive is replayable at all: every captured request, back through the real client, returns what was captured. If this fails, trust nothing else. |
| `mapping.js` | Every payload through every driver's capability map, compared against a snapshot. Catches the silent failure: a Growatt field that changes name turns a capability into `NaN`, which Homey renders as an empty tile rather than an error. |
| `limiter.js` | Request-level identity of the cache and cooldown — including the two regressions that reached a user: a second client for one account being refused instead of served, and cross-host cache reuse that would make `discoverHost` pick the wrong server. |
| `scheduler.js` | The per-device poll scheduler on a virtual clock, against a server that refuses repeats. Checks the two properties that matter — never breaks the rate limit, never misses an upload — across cold-start offsets, payload clock skews, datalogger cadences, `noah`'s 1-minute window, a wrong Homey clock, and payloads with no timestamp at all. |

## Adding a case

Drop a file in `cases/` exporting `async (t) => {}`. Use `t.ok(cond, msg)`, `t.eq(a, b, msg)`,
`t.skip(msg)`, `t.log(msg)`. Take fixtures through `require('../fixtures')` and always guard with
`if (!fixtures.available) return t.skip(...)`.

## Worth adding next

- **Pairing** — `discoverHost()` host selection and error attribution, and `common_driver`'s device
  assembly, including the battery-presence check that must distinguish "no battery" from "could not
  check".
- **Migration** — `migrate()` rebuilds capabilities from the first mismatching index, so appending
  is safe and inserting destroys Insights history. A case that asserts capability ORDER per driver
  would catch that before it ships.
- **Energy roles** — that each driver's `energy` block still matches the capabilities it declares.
