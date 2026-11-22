# Exam client

The candidate terminal and the proctor console. The center gateway serves the built app from `dist/` on the hall network, so a terminal talks to nothing but its gateway. All protocol work happens in `TerminalSession` from `@eplp/protocol`: check-in, unlock at the start beacon, the answer log, transfer restore, and the signed sheet.

| Route      | Who uses it | What it does                                                                  |
| ---------- | ----------- | ----------------------------------------------------------------------------- |
| `/`        | Candidates  | Terminal setup (once), check-in, the waiting room, the exam, and the receipt. |
| `/proctor` | Proctors    | PIN sign-in, check-ins per shift, and transfer approval.                      |

## Run it

The gateway serves `dist/` and checks for it on every request, so a rebuild needs no restart.

```bash
pnpm -C apps/exam-client build
pnpm dev                       # from the repo root: chain, beacon, custodians, gateways
```

Open `http://127.0.0.1:8800/` for Hall A, or `http://127.0.0.1:8800/proctor` for the proctor console. The dev proctor PIN is `2468`. The dev stack prints the admit cards, with roll numbers and check-in codes.

For UI work with hot reload, point the Vite dev server at a running gateway:

```bash
GATEWAY_URL=http://127.0.0.1:8800 pnpm -C apps/exam-client dev
```

## Kiosk browsers need a secure context

The client decrypts papers with Web Crypto, which browsers only enable on HTTPS or on `localhost`. A terminal that opens the gateway over plain HTTP on the hall LAN shows a blocking screen instead of the check-in form. Serve the gateway over HTTPS, or mark its origin as secure when you start Chrome:

```bash
google-chrome --kiosk \
  --user-data-dir=/var/lib/exam-kiosk \
  --unsafely-treat-insecure-origin-as-secure=http://10.0.0.2:8800 \
  http://10.0.0.2:8800/
```

Replace `10.0.0.2:8800` with the gateway's address. Chrome can ignore the flag on the default profile, so keep `--user-data-dir`.

## Behavior to know

- **Terminal ID.** The first visit asks for the desk label, such as `T-01`, and keeps it in `localStorage`. The check-in screen has a link to rename it.
- **Shift.** The terminal picks the live shift, or the next one, from the latest drand round. A shift stays live until its late-entry window closes. Reserve shifts are never picked.
- **Reloads.** Session keys exist only in memory, so a reload or a crash ends the session. Answers saved before it are on the gateway. The terminal remembers the roll number, never the code, and tells the candidate to ask a proctor for a transfer. After the proctor approves, the candidate checks in again and the saved answers come back.
- **Autosave.** Each answer goes to the gateway's log at once, and the terminal retries every 3 seconds until it is saved. The top bar shows the save state.
- **End time.** At the shift's end time the terminal signs and submits the sheet without asking.
- **Marked for review.** This flag lives only on the terminal. It is not part of the sheet, and a transfer does not carry it.

## Verify

`scripts/verify.ts` drives the built app in headless Chrome against a live stack and saves a screenshot per stage. It uses `/usr/bin/google-chrome`, so there is no browser download.

```bash
EPLP_DATA=.data-ui-exam node apps/cli/src/dev.ts --offset 100 --no-portal --seal-in 60 --start-gap 40 --duration 150
AUTO_SUBMIT=1 SHOTS=/tmp/shots pnpm -C apps/exam-client verify
```

The script checks a refused code, the waiting room, unlock at T, answers, a reload that needs a transfer, a proctor-approved move to a new browser, the replaced terminal's refusal, submit, and the receipt. With `AUTO_SUBMIT=1`, a second candidate is left alone until the end time submits for them.
