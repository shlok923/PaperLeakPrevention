import { shiftLabel } from "../lib/exam.ts";
import { clockTime } from "../lib/time.ts";
import { TopBar } from "../ui.tsx";
import type { Candidate, Receipt } from "./Terminal.tsx";
import { Identity } from "./WaitingRoom.tsx";

export function ReceiptScreen({ c, receipt, onFinish }: { c: Candidate; receipt: Receipt; onFinish: () => void }) {
  const s = c.session;
  const code = receipt.receiptCode;
  const total = s.paper?.items.length ?? 0;
  return (
    <div className="screen">
      <TopBar title={s.exam.config.title} sub={`${s.exam.center.name} · ${shiftLabel(s.shift)}`}>
        <Identity rollNo={c.rollNo} terminalId={s.terminalId} />
      </TopBar>
      <main className="receipt enter">
        <div className="receipt__head">
          <p className="label">
            {receipt.auto ? "Time ended. Submitted automatically" : "Submitted"} at <span className="num">{clockTime(receipt.submittedAt)}</span>
          </p>
          <h1 className="display">Your answers are in.</h1>
        </div>

        <div className="receipt__facts">
          <section className="receipt__code panel" aria-labelledby="code-h">
            <h2 className="label" id="code-h">
              Receipt code
            </h2>
            <p className="code mono" aria-label={code.split("").join(" ")}>
              <span>{code.slice(0, 5)}</span>
              <span>{code.slice(5)}</span>
            </p>
            <p className="lead">Write this code on your admit card now, before you leave the terminal.</p>
          </section>
          <div className="receipt__why">
            <h2>Why the code matters</h2>
            <p>
              It is the start of the hash of the answer sheet this terminal signed. The hall posts a fingerprint of every sheet on chain before
              anyone can see the answer key. When results come out, check that your code matches your recorded sheet. If it does not, report
              it: the mismatch is proof that the sheet was changed.
            </p>
            <p className="label">Sheet hash</p>
            <p className="hash mono">{receipt.sheetHash}</p>
          </div>
        </div>

        <div className="receipt__side">
          <dl className="tally tally--rows">
            <div>
              <dt>Answered</dt>
              <dd>
                <span className="num">{receipt.answered}</span> of <span className="num">{total}</span>
              </dd>
            </div>
            <div>
              <dt>Roll number</dt>
              <dd className="mono">{c.rollNo}</dd>
            </div>
            <div>
              <dt>Terminal</dt>
              <dd className="mono">{s.terminalId}</dd>
            </div>
          </dl>
          <div className="btn-row">
            <button type="button" className="btn btn--secondary btn--wide" onClick={onFinish}>
              Clear terminal for the next candidate
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
