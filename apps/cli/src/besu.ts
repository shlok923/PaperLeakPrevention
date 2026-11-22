import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
    copyFileSync,
    rmSync,
} from "node:fs";
import { join } from "node:path";
import { accountOf, ROOT } from "./ops.ts";
import { waitFor, type Supervisor } from "./procs.ts";

const TOOLS = join(ROOT, ".tools");
const BESU_VERSION = "26.11.1";
const BESU_SHA256 =
    "28336f46c44d6660e203546b51b8c81eea0cd3499ceff0d3e716f6b029e5e4f7";
const BESU_URL = `https://github.com/besu-eth/besu/releases/download/${BESU_VERSION}/besu-${BESU_VERSION}.tar.gz`;
const JDK_URL =
    "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5.1%2B2/OpenJDK25U-jdk_x64_linux_hotspot_25.0.5.1_2.tar.gz";
const JDK_SHA256 =
    "760f91b22c3efc9bd1b64ff950598231be82928cc807e30691a0e7a2995a62c0";
export const BESU_DIR = join(TOOLS, `besu-${BESU_VERSION}`);
export const JDK_DIR = join(TOOLS, "jdk-25");

async function fetchTarball(
    url: string,
    sha256: string,
    dest: string,
): Promise<void> {
    if (existsSync(join(dest, "bin"))) return;
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== sha256) throw new Error(`checksum mismatch for ${url}`);
    mkdirSync(dest, { recursive: true });
    const tgz = `${dest}.tar.gz`;
    writeFileSync(tgz, buf);
    const r = spawnSync("tar", [
        "xzf",
        tgz,
        "-C",
        dest,
        "--strip-components=1",
    ]);
    rmSync(tgz);
    if (r.status !== 0) throw new Error(`extract failed: ${r.stderr}`);
}

export async function ensureBesu(): Promise<void> {
    await fetchTarball(JDK_URL, JDK_SHA256, JDK_DIR);
    await fetchTarball(BESU_URL, BESU_SHA256, BESU_DIR);
}

const besuEnv = () => ({
    JAVA_HOME: JDK_DIR,
    BESU_OPTS:
        "-Xmx256m -Xms64m -XX:+UseSerialGC -XX:MaxMetaspaceSize=128m -XX:ReservedCodeCacheSize=48m -Xss512k",
});

export async function startBesu(
    sup: Supervisor,
    rpcPort: number,
    dataDir: string,
    validators = 4,
): Promise<string> {
    await ensureBesu();
    const dir = join(dataDir, "besu");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const alloc = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
            accountOf(i).slice(2).toLowerCase(),
            { balance: "0x3635C9ADC5DEA00000" },
        ]),
    );
    writeFileSync(
        join(dir, "qbft.json"),
        JSON.stringify({
            genesis: {
                config: {
                    chainId: 1337,
                    berlinBlock: 0,
                    londonBlock: 0,
                    shanghaiTime: 0,
                    cancunTime: 0,
                    pragueTime: 0,
                    zeroBaseFee: true,
                    contractSizeLimit: 2147483647,
                    qbft: {
                        blockperiodseconds: 1,
                        epochlength: 30000,
                        requesttimeoutseconds: 4,
                    },
                },
                nonce: "0x0",
                timestamp: "0x58ee40ba",
                gasLimit: "0x1fffffffffffff",
                difficulty: "0x1",
                mixHash:
                    "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
                coinbase: "0x0000000000000000000000000000000000000000",
                alloc,
            },
            blockchain: { nodes: { generate: true, count: validators } },
        }),
    );
    const gen = spawnSync(
        join(BESU_DIR, "bin/besu"),
        [
            "operator",
            "generate-blockchain-config",
            `--config-file=${join(dir, "qbft.json")}`,
            `--to=${join(dir, "out")}`,
            "--private-key-file-name=key",
        ],
        { env: { ...process.env, ...besuEnv() } },
    );
    if (gen.status !== 0)
        throw new Error(`besu config generation failed: ${gen.stderr}`);
    const keys = readdirSync(join(dir, "out/keys"));
    const bootPub = readFileSync(
        join(dir, "out/keys", keys[0]!, "key.pub"),
        "utf8",
    )
        .trim()
        .replace(/^0x/, "");
    keys.forEach((k, i) => {
        const data = join(dir, `n${i}`);
        mkdirSync(data, { recursive: true });
        copyFileSync(join(dir, "out/keys", k, "key"), join(data, "key"));
        sup.start(
            `besu-${i}`,
            join(BESU_DIR, "bin/besu"),
            [
                `--data-path=${data}`,
                `--genesis-file=${join(dir, "out/genesis.json")}`,
                `--p2p-port=${31300 + i}`,
                "--rpc-http-enabled",
                `--rpc-http-port=${rpcPort + i}`,
                "--rpc-http-api=ETH,NET,QBFT,WEB3",
                "--rpc-http-cors-origins=*",
                "--rpc-http-max-active-connections=1000",
                "--host-allowlist=*",
                "--min-gas-price=0",
                "--data-storage-format=BONSAI",
                "--sync-mode=FULL",
                ...(i > 0
                    ? [`--bootnodes=enode://${bootPub}@127.0.0.1:31300`]
                    : []),
            ],
            besuEnv(),
        );
    });
    const rpc = `http://127.0.0.1:${rpcPort}`;
    await waitFor(
        "Besu validators to peer and produce blocks",
        async () => {
            const call = async (method: string) =>
                (
                    (await (
                        await fetch(rpc, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                                jsonrpc: "2.0",
                                id: 1,
                                method,
                                params: [],
                            }),
                        })
                    ).json()) as { result: string }
                ).result;
            return (
                Number(await call("net_peerCount")) >= validators - 1 &&
                Number(await call("eth_blockNumber")) >= 2
            );
        },
        180_000,
        1000,
    );
    return rpc;
}
