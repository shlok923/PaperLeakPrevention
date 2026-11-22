import { HttpError } from "@eplp/protocol";

export interface Refusal {
    title: string;
    detail: string;
}

const unreachable: Refusal = {
    title: "This terminal cannot reach the hall server.",
    detail: "Nothing was sent. Tell a proctor, then try again.",
};

export function checkInRefusal(e: unknown): Refusal {
    if (!(e instanceof HttpError))
        return e instanceof TypeError
            ? unreachable
            : { title: "Check-in failed.", detail: String(e) };
    if (e.status === 403)
        return {
            title: "This roll number and check-in code do not match a seat in this hall for this shift.",
            detail: "Check both against your admit card and type them again. If they match, show your admit card to a proctor.",
        };
    if (e.status === 409 && !/Already checked in/.test(e.body))
        return { title: "Check-in is not open yet.", detail: e.body };
    if (e.status === 409) {
        const terminal = /terminal (\S+?)\./.exec(e.body)?.[1];
        return {
            title: `You are already checked in${terminal ? ` at terminal ${terminal}` : " at another terminal"}.`,
            detail: "A proctor must approve moving you to this terminal. Once they do, check in here again. Your saved answers come with you.",
        };
    }
    return {
        title: "The hall server refused the check-in.",
        detail: `${e.status}: ${e.body}`,
    };
}

const KEY_HOLDERS: Record<string, string> = {
    "0": "No key holder",
    "1": "One key holder",
};

export function unlockRefusal(e: unknown): Refusal {
    const text =
        e instanceof HttpError
            ? e.body
            : e instanceof Error
              ? e.message
              : String(e);
    if (/late entry window has closed/.test(text))
        return {
            title: "The late-entry window for this shift has closed.",
            detail: "The key holders no longer release this paper. See a proctor about the reserve shift.",
        };
    if (/candidate already has a live session/.test(text))
        return {
            title: "The key holders still see you on your earlier terminal.",
            detail: "They release a paper to one terminal at a time. Ask a proctor to approve a transfer, then check in again.",
        };
    if (/too many terminal transfers/.test(text))
        return {
            title: "You have moved terminals the most times allowed in one shift.",
            detail: "The key holders will not release this paper again. See a proctor.",
        };
    const short = /only (\d+) of (\d+) custodians/.exec(text);
    if (short)
        return {
            title: `${KEY_HOLDERS[short[1]!] ?? `${short[1]} key holders`} released keys, and ${short[2]} are needed.`,
            detail: "Your paper stays sealed until enough of them do. Try again in a moment, or tell a proctor if this repeats.",
        };
    return e instanceof TypeError
        ? unreachable
        : { title: "The paper could not be opened.", detail: text };
}

export function submitRefusal(e: unknown): Refusal {
    if (!(e instanceof HttpError))
        return e instanceof TypeError
            ? unreachable
            : { title: "Submitting failed.", detail: String(e) };
    if (e.status === 409)
        return {
            title: "This shift is already closed at the hall server.",
            detail: "Tell a proctor. Your answers up to the last save are on the hall server.",
        };
    if (e.status === 403)
        return {
            title: "This terminal no longer holds your session.",
            detail: "You were moved to another terminal. Continue there, or ask a proctor.",
        };
    return { title: "Submitting failed.", detail: `${e.status}: ${e.body}` };
}
