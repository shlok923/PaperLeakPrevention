import {
    Aes128Gcm,
    CipherSuite,
    DhkemX25519HkdfSha256,
    HkdfSha256,
} from "@hpke/core";
import { fromHex, toHex, type Hex } from "./bytes.ts";

const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes128Gcm(),
});

const INFO = new TextEncoder().encode("eplp.hpke.v1");

export interface HpkeKeyPair {
    publicKey: Hex;
    privateKey: Hex;
}

export interface Sealed {
    enc: Hex;
    ct: Hex;
}

export async function generateHpkeKeyPair(): Promise<HpkeKeyPair> {
    const kp = await suite.kem.generateKeyPair();
    return {
        publicKey: toHex(
            new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey)),
        ),
        privateKey: toHex(
            new Uint8Array(await suite.kem.serializePrivateKey(kp.privateKey)),
        ),
    };
}

export async function seal(
    recipient: Hex,
    plaintext: Uint8Array,
    aad: Uint8Array,
): Promise<Sealed> {
    const recipientPublicKey = await suite.kem.deserializePublicKey(
        fromHex(recipient).buffer as ArrayBuffer,
    );
    const { enc, ct } = await suite.seal(
        { recipientPublicKey, info: INFO },
        plaintext.slice().buffer,
        aad.slice().buffer,
    );
    return { enc: toHex(new Uint8Array(enc)), ct: toHex(new Uint8Array(ct)) };
}

export async function open(
    privateKey: Hex,
    sealed: Sealed,
    aad: Uint8Array,
): Promise<Uint8Array> {
    const recipientKey = await suite.kem.deserializePrivateKey(
        fromHex(privateKey).buffer as ArrayBuffer,
    );
    const pt = await suite.open(
        {
            recipientKey,
            enc: fromHex(sealed.enc).buffer as ArrayBuffer,
            info: INFO,
        },
        fromHex(sealed.ct).buffer as ArrayBuffer,
        aad.slice().buffer,
    );
    return new Uint8Array(pt);
}
