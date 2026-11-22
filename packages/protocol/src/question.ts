import type { Address } from "viem";
import {
    canonicalBytes,
    concatBytes,
    fromHex,
    randomBytes,
    toHex,
    u16,
    type Hex,
} from "./bytes.ts";
import { tagged } from "./hash.ts";

export interface Question {
    text: string;
    options: [string, string, string, string];
    correct: 0 | 1 | 2 | 3;
    image?: { mime: string; data: string };
}

/** What a terminal decrypts: the question without its answer. */
export interface QuestionPayload {
    salt: Hex;
    text: string;
    options: string[];
    image?: { mime: string; data: string };
}

/** What the scorer decrypts after the last shift. */
export interface AnswerPayload {
    salt: Hex;
    correct: number;
}

export interface Slot {
    examId: Hex;
    setter: Address;
    shift: number;
    index: number;
}

export const MAX_IMAGE_BYTES = 512 * 1024;

export function parseQuestions(input: unknown): {
    questions: Question[];
    errors: string[];
} {
    const errors: string[] = [];
    if (!Array.isArray(input))
        return {
            questions: [],
            errors: ["expected a JSON array of questions"],
        };
    const questions: Question[] = [];
    input.forEach((q: unknown, i) => {
        const at = `question ${i + 1}`;
        if (typeof q !== "object" || q === null)
            return errors.push(`${at}: not an object`);
        const { text, options, correct, image } = q as Record<string, unknown>;
        if (typeof text !== "string" || text.trim() === "")
            errors.push(`${at}: text is required`);
        if (
            !Array.isArray(options) ||
            options.length !== 4 ||
            options.some((o) => typeof o !== "string" || o.trim() === "")
        )
            errors.push(`${at}: exactly four non-empty options`);
        if (correct !== 0 && correct !== 1 && correct !== 2 && correct !== 3)
            errors.push(`${at}: correct must be 0, 1, 2 or 3`);
        if (image !== undefined) {
            const img = image as Record<string, unknown>;
            if (
                typeof img.mime !== "string" ||
                !img.mime.startsWith("image/") ||
                typeof img.data !== "string"
            )
                errors.push(
                    `${at}: image needs an image/* mime and base64 data`,
                );
            else if ((img.data.length * 3) / 4 > MAX_IMAGE_BYTES)
                errors.push(`${at}: image larger than 512 KB`);
        }
        questions.push(q as Question);
    });
    return { questions: errors.length ? [] : questions, errors };
}

export const slotKey = (s: Slot): Uint8Array =>
    concatBytes(
        fromHex(s.examId),
        fromHex(s.setter),
        u16(s.shift),
        u16(s.index),
    );

export function splitQuestion(q: Question): {
    payloadQ: QuestionPayload;
    payloadA: AnswerPayload;
} {
    const payloadQ: QuestionPayload = {
        salt: toHex(randomBytes(32)),
        text: q.text,
        options: [...q.options],
    };
    if (q.image) payloadQ.image = { mime: q.image.mime, data: q.image.data };
    return {
        payloadQ,
        payloadA: { salt: toHex(randomBytes(32)), correct: q.correct },
    };
}

export const commitQuestion = (slot: Slot, payload: QuestionPayload): Hex =>
    tagged("eplp.cq", slotKey(slot), canonicalBytes(payload));

export const commitAnswer = (slot: Slot, payload: AnswerPayload): Hex =>
    tagged("eplp.ca", slotKey(slot), canonicalBytes(payload));
