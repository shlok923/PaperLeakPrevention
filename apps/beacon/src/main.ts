import { Hono } from "hono";
import { cors } from "hono/cors";
import { DevBeacon, fromHex, toHex } from "@eplp/protocol";
import {
    env,
    envInt,
    log,
    readJsonFile,
    serve,
    writeJsonFile,
} from "@eplp/node-kit";

/**
 * A local drand stand-in.
 */
const keyFile = env("BEACON_KEY_FILE", ".data/beacon/key.json");
const stored = readJsonFile<{
    secret: string;
    genesisTime: number;
    period: number;
}>(keyFile);
const period = stored?.period ?? envInt("BEACON_PERIOD", 1);
const genesisTime =
    stored?.genesisTime ?? Math.floor(Date.now() / 1000) - period;
const secret = stored ? fromHex(stored.secret) : DevBeacon.generateSecret();
if (!stored)
    writeJsonFile(keyFile, { secret: toHex(secret), genesisTime, period });

const beacon = new DevBeacon(secret, genesisTime, period);
const app = new Hono();
app.use(cors());
app.get("/info", (c) => c.json(beacon.info));
app.get("/public/latest", (c) => {
    const b = beacon.sign(beacon.currentRound());
    return c.json({ ...b, randomness: "" });
});
app.get("/public/:round", (c) => {
    const round = Number(c.req.param("round"));
    if (!Number.isInteger(round) || round < 1) return c.text("bad round", 400);
    if (round > beacon.currentRound())
        return c.text("round not yet reached", 404);
    return c.json({ ...beacon.sign(round), randomness: "" });
});

serve(app, envInt("PORT", 8780), "beacon");
log(
    "beacon",
    `chain ${beacon.info.hash.slice(0, 12)} period ${period}s genesis ${genesisTime}, round now ${beacon.currentRound()}`,
);
