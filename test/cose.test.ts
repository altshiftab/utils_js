import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";

import {decode, encode, CborTag} from "../src/cbor/cbor.js";
import {AlgorithmA128GCM, AlgorithmA256GCM, decrypt, encrypt} from "../src/cose/cose.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.substring(2 * i, 2 * i + 2), 16);
    return bytes;
}

interface Vector {
    input: {
        plaintext: string;
        enveloped: {
            recipients: {
                key: {crv: string; kid: string; x: string; y: string; d: string};
            }[];
        };
    };
    output: {cbor: string};
}

async function readVector(name: string): Promise<Vector> {
    return JSON.parse(await readFile(new URL(`../../test/vectors/${name}`, import.meta.url), "utf-8"));
}

async function vectorPrivateKey(vector: Vector): Promise<CryptoKey> {
    const key = vector.input.enveloped.recipients[0]!.key;
    assert.equal(key.crv, "P-256");

    return await crypto.subtle.importKey(
        "jwk",
        {kty: "EC", crv: key.crv, x: key.x, y: key.y, d: key.d},
        {name: "ECDH", namedCurve: key.crv},
        false,
        ["deriveBits"],
    );
}

test("cbor round trip", () => {
    const value = new CborTag(96, [
        new Uint8Array([0xa1, 0x01, 0x03]),
        new Map<number, unknown>([[5, new Uint8Array(12)], [-1, "negative label"]]),
        null,
        [0, 23, 24, 255, 65536, -1, -25, Number.MAX_SAFE_INTEGER, true, false, "text"],
    ]);

    assert.deepEqual(decode(encode(value)), value);
});

test("cbor plain object encoding", () => {
    // Objects encode identically to text-keyed maps.
    assert.deepEqual(
        encode({b: 1, a: "x", c: new Uint8Array([1, 2])}),
        encode(new Map<string, unknown>([["b", 1], ["a", "x"], ["c", new Uint8Array([1, 2])]])),
    );

    // Undefined-valued properties are omitted, like optional interface properties.
    assert.deepEqual(encode({a: 1, b: undefined}), encode({a: 1}));

    // Nested objects work; class instances do not.
    assert.deepEqual(
        encode({outer: {inner: [1]}}),
        encode(new Map([["outer", new Map([["inner", [1]]])]])),
    );
    assert.throws(() => encode(new Date(0)));
});

test("cbor deterministic map key order", () => {
    const encoded = encode(new Map<number, unknown>([[-1, 0], [4, 0], [1, 0]]));
    // Bytewise key order: 1 (0x01), 4 (0x04), -1 (0x20).
    assert.deepEqual(encoded, new Uint8Array([0xa3, 0x01, 0x00, 0x04, 0x00, 0x20, 0x00]));
});

for (const vectorName of ["p256-hkdf-256-01.json", "p256-hkdf-256-02.json"]) {
    test(`decrypt vector ${vectorName}`, async () => {
        const vector = await readVector(vectorName);
        const privateKey = await vectorPrivateKey(vector);

        const result = await decrypt(hexToBytes(vector.output.cbor), privateKey);

        assert.equal(textDecoder.decode(result.plaintext), vector.input.plaintext);
        assert.equal(
            textDecoder.decode(result.keyIdentifier ?? new Uint8Array(0)),
            vector.input.enveloped.recipients[0]!.key.kid,
        );
    });
}

for (const algorithm of [AlgorithmA128GCM, AlgorithmA256GCM]) {
    test(`encrypt-decrypt round trip (algorithm ${algorithm})`, async () => {
        const keyPair = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, false, ["deriveBits"]);

        const plaintext = textEncoder.encode("This is the content.");
        const keyIdentifier = textEncoder.encode("test-key-id");

        const message = await encrypt(plaintext, keyPair.publicKey, {
            contentEncryptionAlgorithm: algorithm,
            keyIdentifier,
            contentType: "application/cbor",
        });

        const result = await decrypt(message, keyPair.privateKey);

        assert.deepEqual(result.plaintext, plaintext);
        assert.deepEqual(result.keyIdentifier, keyIdentifier);
        assert.equal(result.contentType, "application/cbor");
    });
}

test("decrypt go fixture", async () => {
    // Produced by the github.com/Motmedel/utils_go/pkg/cose Go implementation, using the
    // recipient key from vector p256-hkdf-256-01.
    const hex = (await readFile(new URL("../../test/vectors/go-encrypted.hex", import.meta.url), "utf-8")).trim();

    const privateKey = await crypto.subtle.importKey(
        "jwk",
        {
            kty: "EC",
            crv: "P-256",
            x: "Ze2loSV3wrroKUN_4zhwGhCqo3Xhu1td4QjeQ5wIVR0",
            y: "HlLtdXARY_f55A3fnzQbPcm6hgr34Mp8p-nuzQCE0Zw",
            d: "r_kHyZ-a06rmxM3yESK84r1otSg-aQcVStkRhA-iCM8",
        },
        {name: "ECDH", namedCurve: "P-256"},
        false,
        ["deriveBits"],
    );

    const result = await decrypt(hexToBytes(hex), privateKey);

    assert.equal(textDecoder.decode(result.plaintext), "Interop test content.");
    assert.equal(textDecoder.decode(result.keyIdentifier ?? new Uint8Array(0)), "interop-key-id");
    assert.equal(result.contentType, "application/cbor");
});

test("empty key identifier treated as absent", async () => {
    const keyPair = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, false, ["deriveBits"]);

    const message = await encrypt(textEncoder.encode("This is the content."), keyPair.publicKey, {
        keyIdentifier: new Uint8Array(0),
    });

    const result = await decrypt(message, keyPair.privateKey);
    assert.equal(result.keyIdentifier, null);
});

test("external aad mismatch fails", async () => {
    const keyPair = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, false, ["deriveBits"]);

    const message = await encrypt(textEncoder.encode("This is the content."), keyPair.publicKey, {
        externalAad: textEncoder.encode("external"),
    });

    await assert.rejects(decrypt(message, keyPair.privateKey));
});

test("wrong key fails", async () => {
    const keyPair = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, false, ["deriveBits"]);
    const otherKeyPair = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, false, ["deriveBits"]);

    const message = await encrypt(textEncoder.encode("This is the content."), keyPair.publicKey);

    await assert.rejects(decrypt(message, otherKeyPair.privateKey));
});
