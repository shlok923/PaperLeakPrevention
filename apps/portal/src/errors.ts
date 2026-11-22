import {
    BaseError,
    ContractFunctionRevertedError,
    UserRejectedRequestError,
} from "viem";
import { HttpError } from "@eplp/protocol";

export interface Refusal {
    code: string | null;
    message: string;
}

const CONTRACT: Record<string, string> = {
    NotAuthority: "Only the exam authority's account may do this.",
    NotConfigured: "The exam has not been frozen on chain yet.",
    NotSetter: "This account is not a setter in the frozen config.",
    NotCustodian: "This account is not a custodian in the frozen config.",
    NotCenter: "That address is not a center in the frozen config.",
    CenterRevoked: "The center has been revoked.",
    SealingClosed:
        "The seal round is on chain, so the contract accepts no new setter roots.",
    WrongCount: "The question count must equal this setter's slots.",
    StaleRoot: "The root is not this setter's current root.",
    BadBeacon: "The drand signature did not verify on chain.",
    TooEarly: "The round this needs is not on chain yet.",
    TooLate: "The round this had to happen before is already on chain.",
    AlreadyPosted:
        "This was already posted, and the contract never overwrites it.",
    UnknownShift: "There is no such shift.",
    InvalidWindow:
        "A shift can only move later. It must keep a positive length, end before the answers round and not run into the next shift.",
};

function formatArg(a: unknown): string {
    return typeof a === "bigint"
        ? a.toString()
        : typeof a === "string"
          ? a
          : JSON.stringify(a);
}

export function describeError(e: unknown): Refusal {
    if (e instanceof BaseError) {
        const reverted = e.walk(
            (x) => x instanceof ContractFunctionRevertedError,
        );
        if (
            reverted instanceof ContractFunctionRevertedError &&
            reverted.data
        ) {
            const name = reverted.data.errorName;
            const args = (reverted.data.args ?? []).map(formatArg).join(", ");
            return {
                code: `${name}(${args})`,
                message: CONTRACT[name] ?? reverted.shortMessage,
            };
        }
        if (e.walk((x) => x instanceof UserRejectedRequestError))
            return {
                code: null,
                message: "The transaction was declined in the wallet.",
            };
        return { code: null, message: e.shortMessage };
    }
    if (e instanceof HttpError)
        return { code: `HTTP ${e.status}`, message: e.body || e.message };
    return { code: null, message: e instanceof Error ? e.message : String(e) };
}
