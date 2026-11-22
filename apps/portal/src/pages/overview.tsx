import { memo, useEffect, useRef } from "react";
import { oversample, type ExamConfig } from "@eplp/protocol";
import { useExam, useNow, type Live } from "../exam.tsx";
import { clock, plural, ratio, relative } from "../format.ts";
import { Link, PATHS } from "../router.tsx";
import {
  milestoneMeaning,
  milestoneTitle,
  phaseLine,
  phaseOf,
  shiftName,
  timeline,
  type Phase,
  type Point,
} from "../timeline.ts";
import { Dots, Glyph, Hash, type State } from "../ui.tsx";

export function Overview() {
  const { exam, live } = useExam();
  const now = useNow();
  const cfg = exam.info.config;
  const points = timeline(cfg, live.snapshot, exam.drand, live.drandRound, live.onChain);
  const phase = phaseOf(cfg, live.snapshot, live.drandRound);

  return (
    <>
      <section className="hero hero--centred" data-enter aria-labelledby="hero-h">
        <div className="wrap">
          <div className="hero-text">
            <div className="hero__c">
              <a className="pill" href="#timeline">
                <span>{phaseLine(phase)}</span>
                <span className="muted">See the timeline</span>
              </a>
              <h1 id="hero-h">Sealed exam papers anyone can verify</h1>
              <p className="hero__lead">
                Every question is locked twice: by a drand time-lock that opens at its shift's start round, and by keys that{" "}
                {cfg.threshold} of {cfg.custodians.length} custodians release only after that round.
              </p>
              <div className="btn-row">
                <Link className="btn btn--primary" to={PATHS.results}>
                  Check your result
                </Link>
                <Link className="btn btn--secondary" to={PATHS.audit}>
                  Run the public audit
                </Link>
              </div>
            </div>
            <div className="hero__window">
              <SealWindow cfg={cfg} live={live} points={points} phase={phase} now={now} />
            </div>
          </div>
        </div>
      </section>
      <TimelineSection cfg={cfg} live={live} points={points} now={now} />
      <SealedSteps
        slots={cfg.setters[0] ? cfg.setters[0].perShift * cfg.shifts.length : 0}
        threshold={cfg.threshold}
        custodians={cfg.custodians.length}
        oversample={ratio(oversample(cfg, 0, 0))}
        pool={cfg.pools[0] ?? "the first subject"}
      />
      <SettersSection cfg={cfg} live={live} />
      <CentersSection cfg={cfg} live={live} />
    </>
  );
}

type Focus = { kind: "shift"; shift: number } | { kind: "answers" };

function focusOf(phase: Phase): Focus {
  switch (phase.kind) {
    case "sealing":
      return { kind: "shift", shift: 0 };
    case "waiting":
    case "live":
      return { kind: "shift", shift: phase.shift };
    default:
      return { kind: "answers" };
  }
}

interface Lock {
  key: string;
  state: State;
  title: string;
  detail: string;
}

function locks(cfg: ExamConfig, live: Live, focus: Focus): Lock[] {
  const t = cfg.threshold;
  const n = cfg.custodians.length;
  const round = live.drandRound;
  if (focus.kind === "answers") {
    const open = round >= cfg.answersRound;
    const verified = live.onChain.has(cfg.answersRound);
    return [
      {
        key: "tlock",
        state: open ? "done" : "waiting",
        title: "Answer time-lock",
        detail: open
          ? `Open since round ${cfg.answersRound}${verified ? ", its beacon verified on chain" : ""}.`
          : `Closed until drand signs round ${cfg.answersRound}. That signature does not exist yet.`,
      },
      {
        key: "custodians",
        state: open ? "done" : "waiting",
        title: "Answer-key shares",
        detail: open
          ? `Released by the custodians for scoring and audit.`
          : `${t} of ${n} custodians must release them, and each refuses before round ${cfg.answersRound}.`,
      },
      {
        key: "results",
        state: live.snapshot.resultRoot ? "done" : open ? "active" : "waiting",
        title: "Results",
        detail: live.snapshot.resultRoot
          ? "The result root is on chain. Candidates can check their own sheet against it."
          : "Scored only after the answer key opens. Every sheet was frozen on chain before that.",
      },
    ];
  }
  const w = live.snapshot.windows[focus.shift]!;
  const planned = cfg.shifts[focus.shift]!.startRound;
  const tlockOpen = round >= planned;
  const open = round >= w.start;
  const ended = round >= w.end;
  const paper = cfg.shifts[focus.shift]!.perPool.reduce((a, b) => a + b, 0);
  const pool = cfg.setters.reduce((a, s) => a + s.perShift, 0);
  return [
    {
      key: "tlock",
      state: tlockOpen ? "done" : "waiting",
      title: "Time-lock layer",
      detail: !tlockOpen
        ? `Closed until drand signs round ${planned}. That signature does not exist yet.`
        : !open
          ? `Open since round ${planned}, the planned start. The shift moved to round ${w.start}, so until then only the custodians hold it shut.`
          : `Open since round ${planned}${live.onChain.has(planned) ? ", its beacon verified on chain" : ""}.`,
    },
    {
      key: "custodians",
      state: ended || round > w.start + cfg.lateEntryRounds ? "done" : open ? "active" : "waiting",
      title: "Custodian layer",
      detail: open
        ? `Shares go only to terminals checked in at an allocated center, until round ${w.start + cfg.lateEntryRounds}.`
        : `${t} of ${n} must release key shares, and each refuses before round ${w.start}.`,
    },
    {
      key: "paper",
      state: open ? "done" : "waiting",
      title: "The paper",
      detail: open
        ? `Chosen at round ${w.start}: ${paper} of the ${pool} sealed questions.`
        : `Not chosen yet. Round ${w.start}'s signature picks ${paper} of the ${pool} sealed questions.`,
    },
  ];
}

function SealWindow({ cfg, live, points, phase, now }: { cfg: ExamConfig; live: Live; points: Point[]; phase: Phase; now: number }) {
  const next = points.find((p) => !p.reached);
  const focus = focusOf(phase);
  const heading =
    focus.kind === "answers"
      ? "Answer key and results"
      : phase.kind === "live"
        ? `${shiftName(focus.shift)}: what opened at its start round`
        : `${shiftName(focus.shift)}: why no one can read it now`;
  return (
    <div className="ly-piece win" data-ui role="group" aria-label="Live seal status">
      <div className="win__bar">
        <span className="win__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="win__title">{cfg.title}</span>
        <span className="win__sp" />
        <span className="win__meta">
          drand round <b>{live.drandRound}</b>
        </span>
      </div>
      <div className="win__body">
        <div className="clock">
          <p className="t-label muted">Next on the drand clock</p>
          {next ? (
            <>
              <p className="clock__title">{milestoneTitle(next.milestone)}</p>
              <p className="clock__round">
                Round <b>{next.milestone.round}</b>
              </p>
              <p className="clock__eta">
                {clock(next.atMs)}, {relative(next.atMs, now)}
              </p>
            </>
          ) : (
            <p className="clock__title">Every round has passed</p>
          )}
        </div>
        <div className="locks">
          <p className="t-label muted">{heading}</p>
          <ul>
            {locks(cfg, live, focus).map((l) => (
              <li key={l.key} className={`locks__row is-${l.state}`}>
                <Glyph state={l.state} />
                <div>
                  <p className="locks__title">{l.title}</p>
                  <p className="locks__detail">{l.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function segment(points: Point[], i: number, round: number): number {
  const a = points[i]!.milestone.round;
  const b = points[i + 1]?.milestone.round;
  if (b === undefined || round <= a) return 0;
  return Math.min(1, (round - a) / (b - a));
}

function TimelineSection({ cfg, live, points, now }: { cfg: ExamConfig; live: Live; points: Point[]; now: number }) {
  return (
    <section id="timeline" aria-labelledby="timeline-h">
      <div className="wrap">
        <div className="section-head">
          <h2 id="timeline-h">Exam timeline by drand round</h2>
          <p>Every step waits for a drand round, never for anyone's word. A tick means the contract verified that round's signature.</p>
        </div>
        <div className="lit">
          <div className="win track" data-ui role="group" aria-label="Milestones on the drand clock">
            <div className="win__bar">
              <span className="win__dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="win__title">Milestones</span>
              <span className="win__sp" />
              <span className="win__meta">
                drand round <b>{live.drandRound}</b>
              </span>
            </div>
            <ol className="track__points">
              {points.map((p, i) => {
                const m = p.milestone;
                const state: State = p.onChain ? "done" : p.reached ? "active" : "waiting";
                return (
                  <li key={`${m.kind}-${"shift" in m ? m.shift : ""}`} className={`track__point is-${state}`}>
                    <span className="track__seg" aria-hidden="true" style={{ "--seg": segment(points, i, live.drandRound) } as React.CSSProperties}>
                      <i />
                    </span>
                    <Glyph state={state} />
                    <div className="track__text">
                      <p className="track__title">{milestoneTitle(m)}</p>
                      <p className="track__round">
                        Round <b>{m.round}</b>
                        {m.kind === "start" && m.round !== m.planned ? <span className="muted">, moved from {m.planned}</span> : null}
                      </p>
                      <p className="track__time">{p.reached ? clock(p.atMs) : `${clock(p.atMs)}, ${relative(p.atMs, now)}`}</p>
                      <p className="track__meaning">{milestoneMeaning(m)}</p>
                      <p className="track__chain">{p.onChain ? "Beacon verified on chain" : p.reached ? "Waiting for a poster" : "Not signed yet"}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
        <p className="track__foot">
          {plural(cfg.shifts.length, "shift")} of {cfg.shifts[0]!.perPool.reduce((a, b) => a + b, 0)} questions each. Custodians release keys
          until {cfg.lateEntryRounds} rounds after a shift opens.
        </p>
      </div>
    </section>
  );
}

const SealedSteps = memo(function SealedSteps(p: { slots: number; threshold: number; custodians: number; oversample: string; pool: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let api: { destroy?: () => void } | null = null;
    let gone = false;
    const timer = setTimeout(() => {
      if (!window.kit) return el.classList.add("mo-safe");
      window.kit
        .then((k) => k.moments.mount(el))
        .then((a) => {
          if (gone) a?.destroy?.();
          else api = a;
        })
        .catch(() => el.classList.add("mo-safe"));
    }, 0);
    return () => {
      gone = true;
      clearTimeout(timer);
      api?.destroy?.();
    };
  }, []);
  return (
    <section ref={ref} className="section" id="sealing" style={{ "--h": 2 } as React.CSSProperties} data-moment="pinned-chapters" aria-labelledby="sealing-h">
      <div className="wrap mo-pc__grid">
        <div className="mo-pc__text">
          <h2 id="sealing-h">How a question stays sealed until its round</h2>
          <ol className="mo-pc__steps">
            <li className="mo-pc__step">
              <h3>Sealed in the setter's browser</h3>
              <p>
                Questions are encrypted before they leave the setter's laptop. One transaction commits to all {p.slots}, and the store takes only
                bundles under that root.
              </p>
              <figure className="mo-pc__visual mo-pc__visual--lit">
                <div className="mini" role="img" aria-label="A setter's batch sealed with one transaction">
                  <p className="mini__head">Setter 1, {p.pool}</p>
                  <p className="mini__big">{p.slots} questions sealed</p>
                  <code className="mini__code">submitSetterRoot(root, {p.slots})</code>
                  <p className="mini__foot">1 transaction, then uploads that need no signature</p>
                </div>
              </figure>
            </li>
            <li className="mo-pc__step">
              <h3>Two locks on one drand round</h3>
              <p>
                Half of each key is time-locked to the shift's start round. The other half needs {p.threshold} of {p.custodians} custodians, who
                refuse before that round.
              </p>
              <figure className="mo-pc__visual mo-pc__visual--lit">
                <div className="mini" role="img" aria-label="The two locks on a question key">
                  <p className="mini__head">Key = time-lock half XOR custodian half</p>
                  <p className="mini__row">
                    <span>Time-lock half</span>
                    <b>opens when drand signs the start round</b>
                  </p>
                  <p className="mini__row">
                    <span>Custodian half</span>
                    <b>
                      {p.threshold} of {p.custodians} shares, after that round
                    </b>
                  </p>
                  <p className="mini__foot">Neither half alone opens anything</p>
                </div>
              </figure>
            </li>
            <li className="mo-pc__step">
              <h3>Picked and checked in public</h3>
              <p>
                The same signature picks the paper from a pool {p.oversample} its size. Afterwards anyone can recompute the selection, the scores
                and every root.
              </p>
              <figure className="mo-pc__visual mo-pc__visual--lit">
                <div className="mini" role="img" aria-label="Audit checks anyone can run">
                  <p className="mini__head">Public audit</p>
                  <p className="mini__row">
                    <span>Paper selection</span>
                    <b>from the start beacon</b>
                  </p>
                  <p className="mini__row">
                    <span>Key releases</span>
                    <b>none before the start round</b>
                  </p>
                  <p className="mini__row">
                    <span>Results</span>
                    <b>root matches the chain</b>
                  </p>
                </div>
              </figure>
            </li>
          </ol>
        </div>
        <div className="mo-pc__visuals frame" />
      </div>
    </section>
  );
});

function poolSize(cfg: ExamConfig, pool: number): string {
  const f = cfg.shifts.map((_, s) => ratio(oversample(cfg, s, pool)));
  return new Set(f).size === 1 ? `a pool ${f[0]} the paper in every shift` : `a pool ${f.map((x, s) => `${x} the paper in ${shiftName(s)}`).join(", ")}`;
}

function SettersSection({ cfg, live }: { cfg: ExamConfig; live: Live }) {
  return (
    <section id="setters" className="g2m" aria-labelledby="setters-h">
      <div className="wrap grid grid--top">
        <div className="span-6 stack-6">
          <div className="section-head">
            <h2 id="setters-h">Exam setters and their question pools</h2>
            <p>Each pool holds more questions than a paper uses, so no setter knows which of their questions will appear.</p>
          </div>
          <ul className="pools">
            {cfg.pools.map((pool, i) => {
              const setters = cfg.setters.filter((s) => s.pool === i);
              const perShift = setters.reduce((n, s) => n + s.perShift, 0);
              return (
                <li key={pool} className="pools__row">
                  <span className="pools__name">{pool}</span>
                  <span className="pools__line">
                    {plural(setters.length, "setter")}, {perShift} questions a shift, {poolSize(cfg, i)}
                  </span>
                </li>
              );
            })}
            <li className="pools__row">
              <span className="pools__name">Custodians</span>
              <span className="pools__line">
                {cfg.custodians.length} hold key shares; any {cfg.threshold} can open a question, none before its round
              </span>
            </li>
          </ul>
        </div>
        <div className="span-6 start-7 lit">
          <div className="win" data-ui role="group" aria-label="Setter submissions on chain">
            <div className="win__bar">
              <span className="win__dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="win__title">Setter roots</span>
              <span className="win__sp" />
              <span className="win__meta">
                {live.snapshot.setters.filter((s) => s.eligible).length} of {cfg.setters.length} eligible
              </span>
            </div>
            <table className="table win__table">
              <caption className="sr-only">Setter submissions</caption>
              <thead>
                <tr>
                  <th scope="col">Setter</th>
                  <th scope="col" className="hide-sm">
                    Root on chain
                  </th>
                  <th scope="col">Custodians</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {live.snapshot.setters.map((s, i) => {
                  const c = cfg.setters[i]!;
                  return (
                    <tr key={s.account}>
                      <td>
                        Setter {i + 1}, {cfg.pools[c.pool]}
                      </td>
                      <td className="hide-sm">{s.root ? <Hash value={s.root} n={4} /> : <span className="muted">Not submitted</span>}</td>
                      <td className="nowrap">
                        <Dots have={s.acks} need={cfg.threshold} of={cfg.custodians.length} /> {s.acks} of {cfg.threshold}
                      </td>
                      <td>
                        <span className={`state state--${s.eligible ? "done" : "waiting"}`}>
                          {s.eligible ? "Eligible" : live.snapshot.sealed ? "Left out" : s.root ? "Checking" : "Not submitted"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

function CentersSection({ cfg, live }: { cfg: ExamConfig; live: Live }) {
  const result = live.snapshot.resultRoot;
  const sheets = live.postings.reduce((n, p) => n + p.sheets, 0);
  return (
    <section id="centers" className="g2m" aria-labelledby="centers-h">
      <div className="wrap grid grid--top">
        <div className="span-6 stack-6">
          <div className="section-head">
            <h2 id="centers-h">Exam centers and the result root</h2>
            <p>After each shift a center sends one transaction: a root over its check-ins and a root over every signed answer sheet.</p>
          </div>
          <div className="result-root">
            <p className="t-label muted">Result root on chain</p>
            {result ? (
              <>
                <p className="result-root__hash">
                  <Hash value={result} n={10} />
                </p>
                <p>Every score is a leaf under this root, so each candidate can prove their own result from their admit card.</p>
              </>
            ) : (
              <p className="result-root__wait">
                Published after round {cfg.answersRound}, when the answer key opens. {plural(sheets, "signed sheet")} on chain so far.
              </p>
            )}
          </div>
          <ul className="proves">
            <li>
              <b>The receipt code</b> from the terminal matches the signed sheet.
            </li>
            <li>
              <b>The sheet</b> sits under its center's response root on chain.
            </li>
            <li>
              <b>The score</b> sits under the result root and follows from the answer key.
            </li>
          </ul>
        </div>
        <div className="span-6 start-7 lit">
          <div className="win" data-ui role="group" aria-label="Center postings per shift">
            <div className="win__bar">
              <span className="win__dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="win__title">Center postings</span>
              <span className="win__sp" />
              <span className="win__meta">{plural(sheets, "sheet")}</span>
            </div>
            <table className="table win__table">
              <caption className="sr-only">Center postings per shift</caption>
              <thead>
                <tr>
                  <th scope="col">Center</th>
                  <th scope="col">Sheets</th>
                  <th scope="col">Response root</th>
                </tr>
              </thead>
              {cfg.shifts.map((_, shift) => {
                const w = live.snapshot.windows[shift]!;
                const alloc = live.snapshot.allocationRoots[shift];
                return (
                  <tbody key={shift}>
                    <tr className="group-row">
                      <th scope="rowgroup" colSpan={3}>
                        {shiftName(shift)}, rounds {w.start} to {w.end}
                        <span className="muted"> · allocation {alloc ? <Hash value={alloc} n={4} /> : "not posted"}</span>
                      </th>
                    </tr>
                    {cfg.centers.map((c, center) => {
                      const p = live.postings.find((x) => x.shift === shift && x.center === center);
                      return (
                        <tr key={center}>
                          <td>
                            {c.name}
                            {live.snapshot.centerRevoked[center] ? <span className="state state--failed">Revoked</span> : null}
                          </td>
                          <td>{p ? p.sheets : <span className="muted">-</span>}</td>
                          <td>
                            {p ? (
                              <Hash value={p.responseRoot} n={4} />
                            ) : (
                              <span className="muted">{live.drandRound < w.end ? `After round ${w.end}` : "Not posted"}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Closing() {
  const answersRound = useExam().exam.info.config.answersRound;
  return (
    <footer className="footer closing footer--statement" id="contact" aria-labelledby="close-h">
      <div className="wrap">
        <div className="closing__cta close--word">
          <div className="section-head--split">
            <div>
              <h2 id="close-h">Check your result</h2>
              <p className="t-lead">
                Your roll number and check-in code find your sheet and prove it is in the on-chain roots, from round {answersRound}.
              </p>
            </div>
            <Link className="btn btn--primary" to={PATHS.results}>
              Check your result
            </Link>
          </div>
          <p className="close__word" aria-hidden="true">
            EPLP
          </p>
        </div>
        <div className="closing__links">
          <div className="grid">
            <div className="span-6 stack-4">
              <Link className="nav__logo" to={PATHS.overview}>
                EPLP
              </Link>
              <p className="footer__lede">Exam papers sealed by drand and a custodian committee, checked by anyone.</p>
            </div>
            <div className="span-2 footer__col">
              <h3>Exam</h3>
              <ul>
                <li>
                  <a href="#timeline">Timeline</a>
                </li>
                <li>
                  <a href="#setters">Pools</a>
                </li>
                <li>
                  <a href="#centers">Centers</a>
                </li>
              </ul>
            </div>
            <div className="span-2 footer__col">
              <h3>Roles</h3>
              <ul>
                <li>
                  <Link to={PATHS.setter}>Setters</Link>
                </li>
                <li>
                  <Link to={PATHS.authority}>Authority</Link>
                </li>
              </ul>
            </div>
            <div className="span-2 footer__col">
              <h3>Checks</h3>
              <ul>
                <li>
                  <Link to={PATHS.results}>Results</Link>
                </li>
                <li>
                  <Link to={PATHS.audit}>Audit</Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="footer__legal">
            <span>© 2026 EPLP</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
