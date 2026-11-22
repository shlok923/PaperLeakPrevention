# EPLP: exam paper leak prevention

A computer-based exam where nobody can see the paper before it starts. That includes the exam authority, any setter, the storage operator, the custodians and the exam centers. Nobody picks which questions appear, and every step can be checked by anyone afterwards.

- **Two locks on every question.** A time-lock opens only when the public drand randomness network publishes the shift's start round. Custodian keys open only when `t` of `n` independent custodians release their shares, and they release only after seeing that same round. Either group cheating alone gets nothing before T.
- **The paper exists only at T.** The start round's beacon value also picks which questions appear, from a pool about twice the paper's size. Setters know their own questions, never which ones were picked.
- **Centers hold no keys.** Custodians seal key shares to one candidate terminal's session key. Each candidate gets their own question and option order, and a watermark of their roll number and terminal.
- **Responses are frozen before answers exist.** Centers post a hash of every signed answer sheet before the answer key can be opened, so no one can change a response after learning the answers.
- **The chain is the referee.** A Solidity contract stores only commitments, roots and verified drand beacons. Its clock is drand, not block time.

## Run it

You need Node 24+, pnpm, and [Foundry](https://getfoundry.sh) (`anvil`, `forge`).

```sh
pnpm install
pnpm build          # contracts -> ABI, portal, exam client
pnpm dev            # local demo: chain, beacon, store, 3 custodians, 2 halls, portal
```

| Flag                                          | Effect                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `--besu`                                      | Runs four Hyperledger Besu QBFT validators instead of Anvil                   |
| `--quicknet`                                  | Uses the real League of Entropy drand network instead of the local dev beacon |
| `--seal-in 180 --start-gap 60 --duration 600` | Timeline in seconds                                                           |
| `--manual-setters 0,3`                        | Setters to leave for the portal                                               |
| `--no-allocate`                               | Skip demo candidates, to allocate from the portal instead                     |
| `--offset 100`                                | Shifts every port, to run several stacks side by side                         |

## Check it

```sh
pnpm test
pnpm e2e            # the whole protocol on real processes, about 3 minutes
pnpm -C apps/cli e2e:besu   # the same on four Besu QBFT validators
pnpm eplp audit     # independent audit of the running demo from public data
```

The end-to-end run asserts each claim, including the refusals. A candidate from another hall cannot check in. Every custodian refuses a key request before the start beacon. A second terminal needs a proctor transfer, and the replaced session cannot submit. Late entry is refused. Shift papers are disjoint. Scores match what was answered. All audit checks pass.

## Layout

| Path                 | What it is                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts` | `ExamRegistry.sol` and `DrandBls.sol`, Foundry tests                               |
| `packages/protocol`  | Everything else, shared by browser and services: sealing, time-lock, HPKE, Shamir, selection, terminal session, scoring, audit |
| `packages/node-kit`  | Small runtime helpers for the services                                                                                         |
| `apps/beacon`        | Local drand stand-in with the real scheme and HTTP API                                                                         |
| `apps/store`         | Public store; accepts a document only if it matches an on-chain root                                                           |
| `apps/custodian`     | Holds one share per question, acknowledges batches, posts beacons, releases at T                                               |
| `apps/gateway`       | One per exam center: prefetch, check-in, key relay, answer backup, center postings, serves the exam client                     |
| `apps/exam-client`   | Candidate terminal (kiosk) and proctor console                                                                                 |
| `apps/portal`        | Public status, setter submission, authority actions, candidate results, audit                                                  |
| `apps/cli`           | Dev launcher, end-to-end test, operator commands, Besu runner                                                                  |

## Exam terminals on a LAN

WebCrypto only runs in a secure context. On one machine, `127.0.0.1` already counts as secure. For terminals reaching a gateway over plain HTTP on a LAN, launch Chrome in kiosk mode with `--unsafely-treat-insecure-origin-as-secure=http://<gateway-ip>:8800`, or put the gateway behind TLS.
