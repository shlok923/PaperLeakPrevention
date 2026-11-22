import {
    useEffect,
    useMemo,
    useState,
    type FormEvent,
    type ReactNode,
} from "react";
import { isAddress, type Address } from "viem";
import {
    configHash,
    deployRegistry,
    httpBeaconSource,
    publicKeyToEip2537,
    readExam,
    roundAt,
    roundTimeMs,
    send,
    toAbiConfig,
    validateConfig,
    type ChainInfo,
    type ExamConfig,
    type Hex,
} from "@eplp/protocol";
import { describeError, type Refusal } from "../errors.ts";
import { useExam, type Exam } from "../exam.tsx";
import { clock } from "../format.ts";
import type { Signer } from "../identity.tsx";
import { shiftName } from "../timeline.ts";
import { Hash, RefusalNote, Steps, type StepItem } from "../ui.tsx";

interface Draft {
    title: string;
    pools: string[];
    setters: { account: string; pool: number; perShift: string }[];
    custodians: { account: string; hpkeKey: string }[];
    threshold: string;
    centers: { account: string; name: string }[];
    shifts: {
        start: string;
        end: string;
        perPool: string[];
        reserve: boolean;
    }[];
    seal: string;
    answers: string;
    lateEntryMinutes: string;
    spare: string;
    marksCorrect: string;
    marksWrong: string;
    clientHash: string;
}

type Field =
    | "title"
    | "pools"
    | "setters"
    | "custodians"
    | "threshold"
    | "centers"
    | "shifts"
    | `shift-${number}`
    | "seal"
    | "answers"
    | "lateEntry"
    | "spare"
    | "marks"
    | "clientHash";

interface Problem {
    field: Field;
    message: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
export function toLocalInput(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const fromLocalInput = (v: string): number =>
    v ? new Date(v).getTime() : Number.NaN;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const int = (v: string) =>
    /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;

function draftFrom(cfg: ExamConfig, info: ChainInfo, leadMs: number): Draft {
    const delta = Date.now() + leadMs - roundTimeMs(info, cfg.sealRound);
    const at = (round: number) =>
        toLocalInput(
            Math.round((roundTimeMs(info, round) + delta) / 1000) * 1000,
        );
    return {
        title: cfg.title,
        pools: [...cfg.pools],
        setters: cfg.setters.map((s) => ({
            account: s.account,
            pool: s.pool,
            perShift: String(s.perShift),
        })),
        custodians: cfg.custodians.map((c) => ({
            account: c.account,
            hpkeKey: c.hpkeKey,
        })),
        threshold: String(cfg.threshold),
        centers: cfg.centers.map((c) => ({ account: c.account, name: c.name })),
        shifts: cfg.shifts.map((s) => ({
            start: at(s.startRound),
            end: at(s.endRound),
            perPool: s.perPool.map(String),
            reserve: s.reserve,
        })),
        seal: at(cfg.sealRound),
        answers: at(cfg.answersRound),
        lateEntryMinutes: String(
            Math.round(((cfg.lateEntryRounds * info.period) / 60) * 100) / 100,
        ),
        spare: String(cfg.spare),
        marksCorrect: String(cfg.marksCorrect),
        marksWrong: String(cfg.marksWrong),
        clientHash: cfg.clientHash,
    };
}

function fieldOf(message: string): Field {
    const shift = /^shift (\d+)/.exec(message);
    if (shift) return `shift-${Number(shift[1])}`;
    if (/^at least one pool/.test(message)) return "pools";
    if (/^at least one shift/.test(message)) return "shifts";
    if (/custodian/.test(message)) return "custodians";
    if (/^threshold/.test(message)) return "threshold";
    if (/setter/.test(message)) return "setters";
    if (/center/.test(message)) return "centers";
    if (/^sealing/.test(message)) return "seal";
    if (/^answers/.test(message)) return "answers";
    if (/correct answer/.test(message)) return "marks";
    return "title";
}

function parseDraft(
    d: Draft,
    info: ChainInfo,
    nowRound: number,
): { cfg: ExamConfig | null; problems: Problem[] } {
    const problems: Problem[] = [];
    const say = (field: Field, message: string) =>
        problems.push({ field, message });
    const round = (v: string, field: Field, what: string) => {
        const ms = fromLocalInput(v);
        if (!Number.isFinite(ms)) {
            say(field, `Write the ${what} as a date and time`);
            return 0;
        }
        return roundAt(info, ms);
    };
    if (!d.title.trim()) say("title", "Write the exam's title");
    d.pools.forEach(
        (p, i) => !p.trim() && say("pools", `Subject ${i + 1} needs a name`),
    );
    d.setters.forEach((s, i) => {
        if (!isAddress(s.account))
            say(
                "setters",
                `Setter ${i + 1}: write a 0x address of 40 hex digits`,
            );
        if (!(int(s.perShift) >= 1))
            say(
                "setters",
                `Setter ${i + 1}: questions a shift must be a whole number, 1 or more`,
            );
    });
    d.custodians.forEach((c, i) => {
        if (!isAddress(c.account))
            say(
                "custodians",
                `Custodian ${i + 1}: write a 0x address of 40 hex digits`,
            );
        if (!HEX32.test(c.hpkeKey))
            say(
                "custodians",
                `Custodian ${i + 1}: the HPKE public key is 0x and 64 hex digits`,
            );
    });
    d.centers.forEach((c, i) => {
        if (!isAddress(c.account))
            say(
                "centers",
                `Center ${i + 1}: write a 0x address of 40 hex digits`,
            );
        if (!c.name.trim()) say("centers", `Center ${i + 1} needs a name`);
    });
    const shifts = d.shifts.map((s, i) => {
        const perPool = d.pools.map((_, p) => int(s.perPool[p] ?? ""));
        if (perPool.some((n) => !(n >= 0)))
            say(
                `shift-${i}`,
                `${shiftName(i)}: every subject needs a question count`,
            );
        return {
            startRound: round(s.start, `shift-${i}`, `${shiftName(i)} start`),
            endRound: round(s.end, `shift-${i}`, `${shiftName(i)} end`),
            perPool,
            reserve: s.reserve,
        };
    });
    const threshold = int(d.threshold);
    if (!Number.isFinite(threshold))
        say("threshold", "Write the threshold as a whole number");
    const late = Number(d.lateEntryMinutes);
    if (!(late >= 0))
        say("lateEntry", "Write the late-entry window in minutes");
    const spare = int(d.spare);
    if (!(spare >= 0))
        say("spare", "Write the spare count as a whole number, 0 or more");
    const marksCorrect = int(d.marksCorrect);
    const marksWrong = int(d.marksWrong);
    if (!Number.isFinite(marksCorrect) || !Number.isFinite(marksWrong))
        say("marks", "Write both marks as whole numbers");
    if (!HEX32.test(d.clientHash))
        say("clientHash", "The client hash is 0x and 64 hex digits");
    const sealRound = round(d.seal, "seal", "seal time");
    const answersRound = round(d.answers, "answers", "answer-key time");
    if (sealRound && sealRound <= nowRound)
        say(
            "seal",
            `Sealing must close after the current drand round, ${nowRound}`,
        );
    const U16 = 65535;
    d.setters.forEach(
        (s, i) =>
            int(s.perShift) * d.shifts.length > U16 &&
            say(
                "setters",
                `Setter ${i + 1}: at most ${Math.floor(U16 / d.shifts.length)} questions a shift`,
            ),
    );
    shifts.forEach(
        (s, i) =>
            s.perPool.some((n) => n > U16) &&
            say(
                `shift-${i}`,
                `${shiftName(i)}: at most ${U16} questions a subject`,
            ),
    );
    if (spare > U16) say("spare", `At most ${U16} spare questions`);
    if (threshold > 255) say("threshold", "At most 255 custodians needed");
    if (d.pools.length > 255) say("pools", "At most 255 subjects");
    if ([marksCorrect, marksWrong].some((m) => m < -128 || m > 127))
        say("marks", "Marks run from -128 to 127");
    if ((late * 60) / info.period > 0xffffffff)
        say("lateEntry", "The late-entry window is too long");
    if (problems.length) return { cfg: null, problems };

    const cfg: ExamConfig = {
        title: d.title.trim(),
        pools: d.pools.map((p) => p.trim()),
        setters: d.setters.map((s) => ({
            account: s.account as Address,
            pool: s.pool,
            perShift: int(s.perShift),
        })),
        custodians: d.custodians.map((c) => ({
            account: c.account as Address,
            hpkeKey: c.hpkeKey as Hex,
        })),
        threshold,
        centers: d.centers.map((c) => ({
            account: c.account as Address,
            name: c.name.trim(),
        })),
        shifts,
        spare,
        lateEntryRounds: Math.round((late * 60) / info.period),
        sealRound,
        answersRound,
        marksCorrect,
        marksWrong,
        clientHash: d.clientHash as Hex,
        drand: {
            publicKey: `0x${info.public_key}`,
            publicKeyG2: publicKeyToEip2537(info.public_key),
            genesisTime: info.genesis_time,
            period: info.period,
            chainHash: `0x${info.hash}`,
        },
    };
    const rules = validateConfig(cfg).map((message) => ({
        field: fieldOf(message),
        message,
    }));
    try {
        configHash(cfg);
    } catch (e) {
        rules.push({
            field: "title",
            message: `The config cannot be encoded for the contract: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
        });
    }
    return { cfg: rules.length ? null : cfg, problems: rules };
}

type Create =
    | { kind: "idle" }
    | { kind: "deploying" }
    | { kind: "configuring"; registry: Address }
    | {
          kind: "done";
          registry: Address;
          tx: Hex;
          configHash: Hex;
          examId: Hex;
          title: string;
      }
    | {
          kind: "failed";
          stage: "deploying" | "configuring";
          refusal: Refusal;
          registry?: Address;
      };

function useBeaconInfo(exam: Exam): ChainInfo | null {
    const [info, setInfo] = useState<ChainInfo | null>(null);
    useEffect(() => {
        httpBeaconSource(exam.dep.drandUrl)
            .info()
            .then(setInfo)
            .catch(() => setInfo(exam.drand));
    }, [exam]);
    return info;
}

const LEAD_MS = 5 * 60_000;

export function CreateExamDesk({ signer }: { signer: Signer }) {
    const { exam, live } = useExam();
    const info = useBeaconInfo(exam);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [run, setRun] = useState<Create>({ kind: "idle" });
    const [tried, setTried] = useState(false);

    useEffect(() => {
        if (info && !draft)
            setDraft(draftFrom(exam.info.config, info, LEAD_MS));
    }, [info, draft, exam]);

    const parsed = useMemo(
        () => (draft && info ? parseDraft(draft, info, live.drandRound) : null),
        [draft, info, live.drandRound],
    );
    if (!draft || !info || !parsed)
        return (
            <p className="note">Reading the drand beacon's chain information</p>
        );

    const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
    const issues = (field: Field | ((f: Field) => boolean)) => {
        const list = parsed.problems.filter((p) =>
            typeof field === "function" ? field(p.field) : p.field === field,
        );
        return list.length ? (
            <ul className="field__error form-errors" role="alert">
                {list.map((p) => (
                    <li key={p.message}>
                        {p.message.charAt(0).toUpperCase() + p.message.slice(1)}
                    </li>
                ))}
            </ul>
        ) : null;
    };
    const roundNote = (v: string) => {
        const ms = fromLocalInput(v);
        return Number.isFinite(ms) ? `round ${roundAt(info, ms)}` : "";
    };

    const create = async (e: FormEvent) => {
        e.preventDefault();
        setTried(true);
        const cfg = parsed.cfg;
        if (!cfg) return;
        let registry: Address | undefined =
            run.kind === "failed" ? run.registry : undefined;
        try {
            if (!registry) {
                setRun({ kind: "deploying" });
                registry = await deployRegistry(signer.wallet, exam.client);
            }
            setRun({ kind: "configuring", registry });
            const tx = await send(
                signer.wallet,
                exam.client,
                registry,
                "configure",
                [toAbiConfig(cfg)] as never,
            );
            const created = await readExam(exam.client, registry);
            if (created.configHash !== configHash(cfg))
                throw new Error(
                    "The new registry's config hash differs from the config sent.",
                );
            setRun({
                kind: "done",
                registry,
                tx,
                configHash: created.configHash,
                examId: created.examId,
                title: created.config.title,
            });
        } catch (err) {
            setRun({
                kind: "failed",
                stage: registry ? "configuring" : "deploying",
                refusal: describeError(err),
                ...(registry ? { registry } : {}),
            });
        }
    };

    const busy = run.kind === "deploying" || run.kind === "configuring";
    const steps: StepItem[] = [
        {
            key: "deploy",
            state:
                run.kind === "deploying"
                    ? "active"
                    : run.kind === "idle"
                      ? "waiting"
                      : run.kind === "failed" && run.stage === "deploying"
                        ? "failed"
                        : "done",
            title: "Wallet popup 1 of 2: deploy a new ExamRegistry",
            detail:
                "registry" in run && run.registry ? (
                    <Hash value={run.registry} />
                ) : undefined,
        },
        {
            key: "configure",
            state:
                run.kind === "configuring"
                    ? "active"
                    : run.kind === "done"
                      ? "done"
                      : run.kind === "failed" && run.stage === "configuring"
                        ? "failed"
                        : "waiting",
            title: "Wallet popup 2 of 2: configure, which freezes this config on chain",
            detail: run.kind === "done" ? <Hash value={run.tx} /> : undefined,
        },
    ];

    return (
        <section
            className="desk-section"
            id="create"
            aria-labelledby="create-h"
        >
            <div className="section-head">
                <h2 id="create-h">New exam</h2>
                <p>
                    Every field of the exam config, frozen on chain in one
                    registry. It opens with the running exam's values and every
                    time moved so sealing closes in 5 minutes. Times convert to
                    drand rounds of the beacon at {exam.dep.drandUrl}.
                </p>
            </div>
            <form
                className="create"
                noValidate
                onSubmit={(e) => void create(e)}
            >
                <Group title="Exam" note={issues("title")}>
                    <div className="field">
                        <label htmlFor="cx-title">Title</label>
                        <input
                            id="cx-title"
                            value={draft.title}
                            onChange={(e) => set({ title: e.target.value })}
                        />
                    </div>
                    <div className="field">
                        <label htmlFor="cx-client">
                            Exam client build hash
                        </label>
                        <input
                            id="cx-client"
                            className="mono"
                            value={draft.clientHash}
                            onChange={(e) =>
                                set({ clientHash: e.target.value.trim() })
                            }
                        />
                        {issues("clientHash")}
                    </div>
                </Group>

                <Group title="Subjects" note={issues("pools")}>
                    {draft.pools.map((p, i) => (
                        <div className="row" key={i}>
                            <div className="field">
                                <label htmlFor={`cx-pool-${i}`}>
                                    Subject {i + 1}
                                </label>
                                <input
                                    id={`cx-pool-${i}`}
                                    value={p}
                                    onChange={(e) =>
                                        set({
                                            pools: draft.pools.map((x, k) =>
                                                k === i ? e.target.value : x,
                                            ),
                                        })
                                    }
                                />
                            </div>
                            <RemoveButton
                                label={`Remove subject ${i + 1}`}
                                disabled={draft.pools.length <= 1}
                                onClick={() =>
                                    set({
                                        pools: draft.pools.filter(
                                            (_, k) => k !== i,
                                        ),
                                        setters: draft.setters
                                            .filter((s) => s.pool !== i)
                                            .map((s) => ({
                                                ...s,
                                                pool:
                                                    s.pool > i
                                                        ? s.pool - 1
                                                        : s.pool,
                                            })),
                                        shifts: draft.shifts.map((s) => ({
                                            ...s,
                                            perPool: s.perPool.filter(
                                                (_, k) => k !== i,
                                            ),
                                        })),
                                    })
                                }
                            />
                        </div>
                    ))}
                    <AddButton
                        onClick={() =>
                            set({
                                pools: [...draft.pools, ""],
                                shifts: draft.shifts.map((s) => ({
                                    ...s,
                                    perPool: [...s.perPool, "0"],
                                })),
                            })
                        }
                    >
                        Add a subject
                    </AddButton>
                </Group>

                <Group title="Setters" note={issues("setters")}>
                    {draft.setters.map((s, i) => (
                        <div className="row row--setter" key={i}>
                            <div className="field">
                                <label htmlFor={`cx-setter-${i}`}>
                                    Setter {i + 1} address
                                </label>
                                <input
                                    id={`cx-setter-${i}`}
                                    className="mono"
                                    value={s.account}
                                    onChange={(e) =>
                                        set({
                                            setters: draft.setters.map(
                                                (x, k) =>
                                                    k === i
                                                        ? {
                                                              ...x,
                                                              account:
                                                                  e.target.value.trim(),
                                                          }
                                                        : x,
                                            ),
                                        })
                                    }
                                />
                            </div>
                            <div className="field">
                                <label htmlFor={`cx-setter-pool-${i}`}>
                                    Subject
                                </label>
                                <select
                                    id={`cx-setter-pool-${i}`}
                                    value={s.pool}
                                    onChange={(e) =>
                                        set({
                                            setters: draft.setters.map(
                                                (x, k) =>
                                                    k === i
                                                        ? {
                                                              ...x,
                                                              pool: Number(
                                                                  e.target
                                                                      .value,
                                                              ),
                                                          }
                                                        : x,
                                            ),
                                        })
                                    }
                                >
                                    {draft.pools.map((p, k) => (
                                        <option key={k} value={k}>
                                            {p || `Subject ${k + 1}`}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="field">
                                <label htmlFor={`cx-setter-n-${i}`}>
                                    Questions a shift
                                </label>
                                <input
                                    id={`cx-setter-n-${i}`}
                                    inputMode="numeric"
                                    value={s.perShift}
                                    onChange={(e) =>
                                        set({
                                            setters: draft.setters.map(
                                                (x, k) =>
                                                    k === i
                                                        ? {
                                                              ...x,
                                                              perShift:
                                                                  e.target
                                                                      .value,
                                                          }
                                                        : x,
                                            ),
                                        })
                                    }
                                />
                            </div>
                            <RemoveButton
                                label={`Remove setter ${i + 1}`}
                                onClick={() =>
                                    set({
                                        setters: draft.setters.filter(
                                            (_, k) => k !== i,
                                        ),
                                    })
                                }
                            />
                        </div>
                    ))}
                    <AddButton
                        onClick={() =>
                            set({
                                setters: [
                                    ...draft.setters,
                                    { account: "", pool: 0, perShift: "5" },
                                ],
                            })
                        }
                    >
                        Add a setter
                    </AddButton>
                </Group>

                <Group
                    title="Custodians"
                    note={issues(
                        (f) => f === "custodians" || f === "threshold",
                    )}
                >
                    {draft.custodians.map((c, i) => (
                        <div className="row row--custodian" key={i}>
                            <div className="field">
                                <label htmlFor={`cx-cust-${i}`}>
                                    Custodian {i + 1} address
                                </label>
                                <input
                                    id={`cx-cust-${i}`}
                                    className="mono"
                                    value={c.account}
                                    onChange={(e) =>
                                        set({
                                            custodians: draft.custodians.map(
                                                (x, k) =>
                                                    k === i
                                                        ? {
                                                              ...x,
                                                              account:
                                                                  e.target.value.trim(),
                                                          }
                                                        : x,
                                            ),
                                        })
                                    }
                                />
                            </div>
                            <div className="field">
                                <label htmlFor={`cx-cust-key-${i}`}>
                                    HPKE public key
                                </label>
                                <input
                                    id={`cx-cust-key-${i}`}
                                    className="mono"
                                    value={c.hpkeKey}
                                    onChange={(e) =>
                                        set({
                                            custodians: draft.custodians.map(
                                                (x, k) =>
                                                    k === i
                                                        ? {
                                                              ...x,
                                                              hpkeKey:
                                                                  e.target.value.trim(),
                                                          }
                                                        : x,
                                            ),
                                        })
                                    }
                                />
                            </div>
                            <RemoveButton
                                label={`Remove custodian ${i + 1}`}
                                onClick={() =>
                                    set({
                                        custodians: draft.custodians.filter(
                                            (_, k) => k !== i,
                                        ),
                                    })
                                }
                            />
                        </div>
                    ))}
                    <div className="row row--end">
                        <AddButton
                            onClick={() =>
                                set({
                                    custodians: [
                                        ...draft.custodians,
                                        { account: "", hpkeKey: "" },
                                    ],
                                })
                            }
                        >
                            Add a custodian
                        </AddButton>
                        <div className="field field--narrow">
                            <label htmlFor="cx-threshold">
                                Custodians needed to open
                            </label>
                            <input
                                id="cx-threshold"
                                inputMode="numeric"
                                value={draft.threshold}
                                onChange={(e) =>
                                    set({ threshold: e.target.value })
                                }
                            />
                        </div>
                    </div>
                </Group>

                <Group title="Centers" note={issues("centers")}>
                    {draft.centers.map((c, i) => (
                        <div className="row row--center" key={i}>
                            <div className="field">
                                <label htmlFor={`cx-center-${i}`}>
                                    Center {i + 1} address
                                </label>
                                <input
                                    id={`cx-center-${i}`}
                                    className="mono"
                                    value={c.account}
                                    onChange={(e) =>
                                        set({
                                            centers: draft.centers.map(
                                                (x, k) =>
                                                    k === i
                                                        ? {
                                                              ...x,
                                                              account:
                                                                  e.target.value.trim(),
                                                          }
                                                        : x,
                                            ),
                                        })
                                    }
                                />
                            </div>
                            <div className="field">
                                <label htmlFor={`cx-center-name-${i}`}>
                                    Name
                                </label>
                                <input
                                    id={`cx-center-name-${i}`}
                                    value={c.name}
                                    onChange={(e) =>
                                        set({
                                            centers: draft.centers.map(
                                                (x, k) =>
                                                    k === i
                                                        ? {
                                                              ...x,
                                                              name: e.target
                                                                  .value,
                                                          }
                                                        : x,
                                            ),
                                        })
                                    }
                                />
                            </div>
                            <RemoveButton
                                label={`Remove center ${i + 1}`}
                                onClick={() =>
                                    set({
                                        centers: draft.centers.filter(
                                            (_, k) => k !== i,
                                        ),
                                    })
                                }
                            />
                        </div>
                    ))}
                    <AddButton
                        onClick={() =>
                            set({
                                centers: [
                                    ...draft.centers,
                                    { account: "", name: "" },
                                ],
                            })
                        }
                    >
                        Add a center
                    </AddButton>
                </Group>

                <Group title="Shifts" note={issues("shifts")}>
                    {draft.shifts.map((s, i) => (
                        <div className="shift-row" key={i}>
                            <div className="row row--times">
                                <div className="field">
                                    <label htmlFor={`cx-shift-start-${i}`}>
                                        {shiftName(i)} starts
                                    </label>
                                    <input
                                        id={`cx-shift-start-${i}`}
                                        type="datetime-local"
                                        step={1}
                                        value={s.start}
                                        onChange={(e) =>
                                            set({
                                                shifts: draft.shifts.map(
                                                    (x, k) =>
                                                        k === i
                                                            ? {
                                                                  ...x,
                                                                  start: e
                                                                      .target
                                                                      .value,
                                                              }
                                                            : x,
                                                ),
                                            })
                                        }
                                    />
                                    <span className="field__count">
                                        {roundNote(s.start)}
                                    </span>
                                </div>
                                <div className="field">
                                    <label htmlFor={`cx-shift-end-${i}`}>
                                        {shiftName(i)} ends
                                    </label>
                                    <input
                                        id={`cx-shift-end-${i}`}
                                        type="datetime-local"
                                        step={1}
                                        value={s.end}
                                        onChange={(e) =>
                                            set({
                                                shifts: draft.shifts.map(
                                                    (x, k) =>
                                                        k === i
                                                            ? {
                                                                  ...x,
                                                                  end: e.target
                                                                      .value,
                                                              }
                                                            : x,
                                                ),
                                            })
                                        }
                                    />
                                    <span className="field__count">
                                        {roundNote(s.end)}
                                    </span>
                                </div>
                                {draft.pools.map((p, k) => (
                                    <div
                                        className="field field--narrow"
                                        key={k}
                                    >
                                        <label
                                            htmlFor={`cx-shift-${i}-pool-${k}`}
                                        >
                                            {p || `Subject ${k + 1}`} questions
                                        </label>
                                        <input
                                            id={`cx-shift-${i}-pool-${k}`}
                                            inputMode="numeric"
                                            value={s.perPool[k] ?? ""}
                                            onChange={(e) =>
                                                set({
                                                    shifts: draft.shifts.map(
                                                        (x, j) =>
                                                            j === i
                                                                ? {
                                                                      ...x,
                                                                      perPool:
                                                                          draft.pools.map(
                                                                              (
                                                                                  _,
                                                                                  q,
                                                                              ) =>
                                                                                  q ===
                                                                                  k
                                                                                      ? e
                                                                                            .target
                                                                                            .value
                                                                                      : (x
                                                                                            .perPool[
                                                                                            q
                                                                                        ] ??
                                                                                        ""),
                                                                          ),
                                                                  }
                                                                : x,
                                                    ),
                                                })
                                            }
                                        />
                                    </div>
                                ))}
                                <label className="check">
                                    <input
                                        type="checkbox"
                                        checked={s.reserve}
                                        onChange={(e) =>
                                            set({
                                                shifts: draft.shifts.map(
                                                    (x, k) =>
                                                        k === i
                                                            ? {
                                                                  ...x,
                                                                  reserve:
                                                                      e.target
                                                                          .checked,
                                                              }
                                                            : x,
                                                ),
                                            })
                                        }
                                    />
                                    Reserve shift
                                </label>
                                <RemoveButton
                                    label={`Remove ${shiftName(i)}`}
                                    disabled={draft.shifts.length <= 1}
                                    onClick={() =>
                                        set({
                                            shifts: draft.shifts.filter(
                                                (_, k) => k !== i,
                                            ),
                                        })
                                    }
                                />
                            </div>
                            {issues(`shift-${i}`)}
                        </div>
                    ))}
                    <AddButton
                        onClick={() => {
                            const last = draft.shifts[draft.shifts.length - 1];
                            const gap = 30 * 60_000;
                            const start = last
                                ? fromLocalInput(last.end) + gap
                                : Date.now() + LEAD_MS + gap;
                            const length = last
                                ? fromLocalInput(last.end) -
                                  fromLocalInput(last.start)
                                : 3 * 3600_000;
                            set({
                                shifts: [
                                    ...draft.shifts,
                                    {
                                        start: toLocalInput(start),
                                        end: toLocalInput(start + length),
                                        perPool: draft.pools.map(() => "5"),
                                        reserve: false,
                                    },
                                ],
                            });
                        }}
                    >
                        Add a shift
                    </AddButton>
                </Group>

                <Group title="Rounds and marks">
                    <div className="row row--times">
                        <div className="field">
                            <label htmlFor="cx-seal">Sealing closes</label>
                            <input
                                id="cx-seal"
                                type="datetime-local"
                                step={1}
                                value={draft.seal}
                                onChange={(e) => set({ seal: e.target.value })}
                            />
                            <span className="field__count">
                                {roundNote(draft.seal)}
                            </span>
                            {issues("seal")}
                        </div>
                        <div className="field">
                            <label htmlFor="cx-answers">Answer key opens</label>
                            <input
                                id="cx-answers"
                                type="datetime-local"
                                step={1}
                                value={draft.answers}
                                onChange={(e) =>
                                    set({ answers: e.target.value })
                                }
                            />
                            <span className="field__count">
                                {roundNote(draft.answers)}
                            </span>
                            {issues("answers")}
                        </div>
                        <div className="field field--narrow">
                            <label htmlFor="cx-late">Late entry, minutes</label>
                            <input
                                id="cx-late"
                                inputMode="decimal"
                                value={draft.lateEntryMinutes}
                                onChange={(e) =>
                                    set({ lateEntryMinutes: e.target.value })
                                }
                            />
                            <span className="field__count">
                                {Math.round(
                                    (Number(draft.lateEntryMinutes) * 60) /
                                        info.period,
                                ) || 0}{" "}
                                rounds
                            </span>
                            {issues("lateEntry")}
                        </div>
                        <div className="field field--narrow">
                            <label htmlFor="cx-spare">
                                Spare questions a subject
                            </label>
                            <input
                                id="cx-spare"
                                inputMode="numeric"
                                value={draft.spare}
                                onChange={(e) => set({ spare: e.target.value })}
                            />
                            {issues("spare")}
                        </div>
                        <div className="field field--narrow">
                            <label htmlFor="cx-correct">
                                Marks for a right answer
                            </label>
                            <input
                                id="cx-correct"
                                inputMode="numeric"
                                value={draft.marksCorrect}
                                onChange={(e) =>
                                    set({ marksCorrect: e.target.value })
                                }
                            />
                        </div>
                        <div className="field field--narrow">
                            <label htmlFor="cx-wrong">
                                Marks for a wrong answer
                            </label>
                            <input
                                id="cx-wrong"
                                inputMode="numeric"
                                value={draft.marksWrong}
                                onChange={(e) =>
                                    set({ marksWrong: e.target.value })
                                }
                            />
                        </div>
                    </div>
                    {issues("marks")}
                    <p className="rules">
                        drand chain <Hash value={`0x${info.hash}`} n={6} />, one
                        round every {info.period} s, genesis{" "}
                        {clock(info.genesis_time * 1000)} on{" "}
                        {new Date(info.genesis_time * 1000).toLocaleDateString(
                            "en-GB",
                        )}
                        .
                    </p>
                </Group>

                <div className="create__submit">
                    <Steps items={steps} label="Creating the exam" />
                    <div className="btn-row">
                        <button
                            type="submit"
                            className="btn btn--primary"
                            disabled={busy || (tried && !parsed.cfg)}
                        >
                            {busy
                                ? "Waiting for the wallet"
                                : "Create the exam on chain"}
                        </button>
                        <button
                            type="button"
                            className="btn btn--secondary"
                            disabled={busy}
                            onClick={() => {
                                setDraft(
                                    draftFrom(exam.info.config, info, LEAD_MS),
                                );
                                setRun({ kind: "idle" });
                                setTried(false);
                            }}
                        >
                            Reset to the running exam's values
                        </button>
                    </div>
                    <p className="form__status" role="status">
                        {parsed.problems.length
                            ? `${parsed.problems.length === 1 ? "1 problem" : `${parsed.problems.length} problems`} to fix before the config can go on chain`
                            : "The config passes every rule the contract checks"}
                    </p>
                    {run.kind === "failed" ? (
                        <RefusalNote
                            refusal={run.refusal}
                            title={`Stopped while ${run.stage}`}
                        />
                    ) : null}
                    {run.kind === "done" ? <Created run={run} /> : null}
                </div>
            </form>
        </section>
    );
}

function Created({ run }: { run: Extract<Create, { kind: "done" }> }) {
    const { exam } = useExam();
    const next = JSON.stringify(
        { ...exam.dep, registry: run.registry },
        null,
        2,
    );
    return (
        <div className="panel-box created" role="status">
            <h3 className="box-title">“{run.title}” is frozen on chain</h3>
            <ul className="rows rows--spec">
                <li>
                    <span className="rows__name">Registry</span>
                    <span className="rows__value">
                        <code className="hash" data-registry={run.registry}>
                            {run.registry}
                        </code>
                    </span>
                </li>
                <li>
                    <span className="rows__name">Config hash</span>
                    <span className="rows__value">
                        <Hash value={run.configHash} n={8} />
                    </span>
                </li>
                <li>
                    <span className="rows__name">Exam id</span>
                    <span className="rows__value">
                        <Hash value={run.examId} n={8} />
                    </span>
                </li>
            </ul>
            <p>
                The store, the {exam.dep.custodianUrls.length} custodians and
                the {exam.dep.gatewayUrls.length} center gateways still watch
                the old registry, <Hash value={exam.info.registry} n={4} />.
                Restart each of them with{" "}
                <code className="hash">REGISTRY={run.registry}</code>; each
                custodian keeps the HPKE key whose public half is in this
                config. Then serve the portal this deployment.json:
            </p>
            <pre className="snippet">{next}</pre>
        </div>
    );
}

function Group({
    title,
    note,
    children,
}: {
    title: string;
    note?: ReactNode;
    children: ReactNode;
}) {
    return (
        <fieldset className="group">
            <legend>{title}</legend>
            {children}
            {note}
        </fieldset>
    );
}

function AddButton({
    onClick,
    children,
}: {
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            className="btn btn--secondary btn--sm add-row"
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function RemoveButton({
    label,
    onClick,
    disabled,
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            className="remove-row"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
        >
            <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
            </svg>
        </button>
    );
}
