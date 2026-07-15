/**
 * COSE (RFC 9052, RFC 9053) encryption over WebCrypto. The COSE_Encrypt structure with direct
 * ECDH-ES key agreement (ECDH-ES + HKDF-256) and AES-GCM content encryption is supported;
 * additional content-encryption algorithms can be added via registerContentEncryption.
 */

import {CborTag, decode, encode} from "../cbor/cbor.js";

export class CoseError extends Error {}

export const AlgorithmA128GCM = 1;
export const AlgorithmA192GCM = 2;
export const AlgorithmA256GCM = 3;
export const AlgorithmEcdhEsHkdf256 = -25;

const encryptMessageTag = 96;

const headerLabelAlgorithm = 1;
const headerLabelContentType = 3;
const headerLabelKeyIdentifier = 4;
const headerLabelIv = 5;
const headerLabelEphemeralKey = -1;

const keyTypeEc2 = 2;
const keyParameterKty = 1;
const keyParameterCrv = -1;
const keyParameterX = -2;
const keyParameterY = -3;

interface CurveParameters {
    id: number;
    namedCurve: string;
    coordinateSize: number;
}

const curveRegistry: CurveParameters[] = [
    {id: 1, namedCurve: "P-256", coordinateSize: 32},
    {id: 2, namedCurve: "P-384", coordinateSize: 48},
    {id: 3, namedCurve: "P-521", coordinateSize: 66},
];

export interface ContentEncryption {
    keyBits: number;
    nonceSize: number;
    encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array>;
    decrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array>;
}

// WebCrypto's BufferSource requires Uint8Array<ArrayBuffer>; values here never use
// SharedArrayBuffer.
function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    return bytes as Uint8Array<ArrayBuffer>;
}

function aesGcm(keyBits: number): ContentEncryption {
    return {
        keyBits,
        nonceSize: 12,
        async encrypt(key, nonce, plaintext, additionalData) {
            const cryptoKey = await crypto.subtle.importKey("raw", asBufferSource(key), "AES-GCM", false, ["encrypt"]);
            return new Uint8Array(
                await crypto.subtle.encrypt(
                    {name: "AES-GCM", iv: asBufferSource(nonce), additionalData: asBufferSource(additionalData)},
                    cryptoKey,
                    asBufferSource(plaintext),
                )
            );
        },
        async decrypt(key, nonce, ciphertext, additionalData) {
            const cryptoKey = await crypto.subtle.importKey("raw", asBufferSource(key), "AES-GCM", false, ["decrypt"]);
            return new Uint8Array(
                await crypto.subtle.decrypt(
                    {name: "AES-GCM", iv: asBufferSource(nonce), additionalData: asBufferSource(additionalData)},
                    cryptoKey,
                    asBufferSource(ciphertext),
                )
            );
        },
    };
}

const contentEncryptionRegistry = new Map<number, ContentEncryption>([
    [AlgorithmA128GCM, aesGcm(128)],
    // NOTE: Chromium's WebCrypto implementation does not support 192-bit AES keys.
    [AlgorithmA192GCM, aesGcm(192)],
    [AlgorithmA256GCM, aesGcm(256)],
]);

export function registerContentEncryption(algorithm: number, contentEncryption: ContentEncryption): void {
    contentEncryptionRegistry.set(algorithm, contentEncryption);
}

function curveParametersFromKey(key: CryptoKey): CurveParameters {
    const namedCurve = (key.algorithm as EcKeyAlgorithm).namedCurve;
    const parameters = curveRegistry.find(entry => entry.namedCurve === namedCurve);
    if (!parameters)
        throw new CoseError(`Unsupported curve: ${namedCurve}`);
    return parameters;
}

function encStructure(bodyProtected: Uint8Array, externalAad: Uint8Array | undefined): Uint8Array {
    return encode(["Encrypt", bodyProtected, externalAad ?? new Uint8Array(0)]);
}

function kdfContext(contentAlgorithm: number, keyBits: number, recipientProtected: Uint8Array): Uint8Array {
    return encode([
        contentAlgorithm,
        [null, null, null],
        [null, null, null],
        [keyBits, recipientProtected],
    ]);
}

async function deriveContentEncryptionKey(
    privateKey: CryptoKey,
    publicKey: CryptoKey,
    sharedSecretBits: number,
    contentAlgorithm: number,
    keyBits: number,
    recipientProtected: Uint8Array,
): Promise<Uint8Array> {
    const sharedSecret = await crypto.subtle.deriveBits(
        {name: "ECDH", public: publicKey},
        privateKey,
        sharedSecretBits,
    );

    const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);

    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: new Uint8Array(0),
                info: asBufferSource(kdfContext(contentAlgorithm, keyBits, recipientProtected)),
            },
            hkdfKey,
            keyBits,
        )
    );
}

export interface EncryptOptions {
    /** Defaults to A256GCM. */
    contentEncryptionAlgorithm?: number;
    /**
     * Identifies the recipient public key; placed in the recipient unprotected header. Empty is
     * treated as absent.
     */
    keyIdentifier?: Uint8Array;
    /** Describes the plaintext; placed in the content protected header. */
    contentType?: string | number;
    /** Additional authenticated data not carried in the message. */
    externalAad?: Uint8Array;
}

/**
 * Produces a COSE_Encrypt message (CBOR tag 96) for a single recipient, using direct ECDH-ES key
 * agreement with HKDF-256 and the configured content-encryption algorithm.
 */
export async function encrypt(
    plaintext: Uint8Array,
    recipientPublicKey: CryptoKey,
    options: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
    const contentAlgorithm = options.contentEncryptionAlgorithm ?? AlgorithmA256GCM;
    const contentEncryption = contentEncryptionRegistry.get(contentAlgorithm);
    if (!contentEncryption)
        throw new CoseError(`Unsupported content-encryption algorithm: ${contentAlgorithm}`);

    const curveParameters = curveParametersFromKey(recipientPublicKey);

    const contentProtectedMap = new Map<number, unknown>([[headerLabelAlgorithm, contentAlgorithm]]);
    if (options.contentType !== undefined)
        contentProtectedMap.set(headerLabelContentType, options.contentType);
    const contentProtected = encode(contentProtectedMap);

    const recipientProtected = encode(new Map<number, unknown>([[headerLabelAlgorithm, AlgorithmEcdhEsHkdf256]]));

    const ephemeralKeyPair = await crypto.subtle.generateKey(
        {name: "ECDH", namedCurve: curveParameters.namedCurve},
        true,
        ["deriveBits"],
    );

    const contentEncryptionKey = await deriveContentEncryptionKey(
        ephemeralKeyPair.privateKey,
        recipientPublicKey,
        curveParameters.coordinateSize * 8,
        contentAlgorithm,
        contentEncryption.keyBits,
        recipientProtected,
    );

    const nonce = crypto.getRandomValues(new Uint8Array(contentEncryption.nonceSize));
    const additionalData = encStructure(contentProtected, options.externalAad);
    const ciphertext = await contentEncryption.encrypt(contentEncryptionKey, nonce, plaintext, additionalData);

    // Uncompressed point: 0x04 || X || Y
    const ephemeralRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeralKeyPair.publicKey));
    const coordinateSize = curveParameters.coordinateSize;
    const ephemeralKeyMap = new Map<number, unknown>([
        [keyParameterKty, keyTypeEc2],
        [keyParameterCrv, curveParameters.id],
        [keyParameterX, ephemeralRaw.slice(1, 1 + coordinateSize)],
        [keyParameterY, ephemeralRaw.slice(1 + coordinateSize)],
    ]);

    const recipientUnprotected = new Map<number, unknown>([[headerLabelEphemeralKey, ephemeralKeyMap]]);
    if (options.keyIdentifier?.length)
        recipientUnprotected.set(headerLabelKeyIdentifier, options.keyIdentifier);

    return encode(
        new CborTag(encryptMessageTag, [
            contentProtected,
            new Map<number, unknown>([[headerLabelIv, nonce]]),
            ciphertext,
            [[recipientProtected, recipientUnprotected, new Uint8Array(0)]],
        ])
    );
}

export interface DecryptOptions {
    /** Additional authenticated data not carried in the message. */
    externalAad?: Uint8Array;
}

export interface DecryptResult {
    plaintext: Uint8Array;
    /** The content protected header's content type, or null if absent. */
    contentType: string | number | null;
    /** The key identifier of the recipient that was used for decryption, or null if absent. */
    keyIdentifier: Uint8Array | null;
    /** The decoded content protected header map, or null if empty. */
    protectedHeader: Map<unknown, unknown> | null;
}

function decodeHeaderMap(data: Uint8Array): Map<unknown, unknown> | null {
    if (data.length === 0)
        return null;

    const headerMap = decode(data);
    if (!(headerMap instanceof Map))
        throw new CoseError("Malformed header map.");
    return headerMap;
}

async function importEphemeralKey(
    ephemeralKeyValue: unknown,
    privateKeyCurveParameters: CurveParameters,
): Promise<CryptoKey> {
    if (!(ephemeralKeyValue instanceof Map))
        throw new CoseError("Malformed ephemeral key.");

    if (ephemeralKeyValue.get(keyParameterKty) !== keyTypeEc2)
        throw new CoseError("Unsupported ephemeral key type.");

    if (ephemeralKeyValue.get(keyParameterCrv) !== privateKeyCurveParameters.id)
        throw new CoseError("Ephemeral key curve mismatch.");

    const x = ephemeralKeyValue.get(keyParameterX);
    const y = ephemeralKeyValue.get(keyParameterY);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array))
        throw new CoseError("Malformed ephemeral key coordinate.");

    const coordinateSize = privateKeyCurveParameters.coordinateSize;
    if (x.length > coordinateSize || y.length > coordinateSize)
        throw new CoseError("Oversized ephemeral key coordinate.");

    const raw = new Uint8Array(1 + 2 * coordinateSize);
    raw[0] = 4;
    raw.set(x, 1 + coordinateSize - x.length);
    raw.set(y, 1 + 2 * coordinateSize - y.length);

    return await crypto.subtle.importKey(
        "raw",
        raw,
        {name: "ECDH", namedCurve: privateKeyCurveParameters.namedCurve},
        true,
        [],
    );
}

/**
 * Decrypts a COSE_Encrypt message (CBOR tag 96, tagged or untagged) using direct ECDH-ES key
 * agreement with HKDF-256.
 */
export async function decrypt(
    message: Uint8Array,
    recipientPrivateKey: CryptoKey,
    options: DecryptOptions = {},
): Promise<DecryptResult> {
    let decodedMessage = decode(message);
    if (decodedMessage instanceof CborTag) {
        if (decodedMessage.tag !== encryptMessageTag)
            throw new CoseError(`Unexpected tag: ${decodedMessage.tag}`);
        decodedMessage = decodedMessage.value;
    }

    if (!Array.isArray(decodedMessage) || decodedMessage.length !== 4)
        throw new CoseError("Malformed message.");

    const [contentProtected, contentUnprotected, ciphertext, recipients] = decodedMessage;
    if (
        !(contentProtected instanceof Uint8Array)
        || !(contentUnprotected instanceof Map)
        || !(ciphertext instanceof Uint8Array)
        || !Array.isArray(recipients)
    )
        throw new CoseError("Malformed message.");

    const contentProtectedMap = decodeHeaderMap(contentProtected);

    const contentAlgorithm = contentProtectedMap?.get(headerLabelAlgorithm);
    if (typeof contentAlgorithm !== "number")
        throw new CoseError("Missing content algorithm.");

    const contentEncryption = contentEncryptionRegistry.get(contentAlgorithm);
    if (!contentEncryption)
        throw new CoseError(`Unsupported content-encryption algorithm: ${contentAlgorithm}`);

    const nonce = contentUnprotected.get(headerLabelIv) ?? contentProtectedMap?.get(headerLabelIv);
    if (!(nonce instanceof Uint8Array))
        throw new CoseError("Missing iv.");

    const additionalData = encStructure(contentProtected, options.externalAad);

    const privateKeyCurveParameters = curveParametersFromKey(recipientPrivateKey);

    const contentTypeValue = contentProtectedMap?.get(headerLabelContentType);
    const contentType =
        typeof contentTypeValue === "string" || typeof contentTypeValue === "number" ? contentTypeValue : null;

    const recipientErrors: unknown[] = [];

    for (const recipient of recipients) {
        try {
            if (!Array.isArray(recipient) || recipient.length < 3)
                throw new CoseError("Malformed recipient.");

            const [recipientProtected, recipientUnprotected] = recipient;
            if (!(recipientProtected instanceof Uint8Array) || !(recipientUnprotected instanceof Map))
                throw new CoseError("Malformed recipient.");

            const recipientProtectedMap = decodeHeaderMap(recipientProtected);
            if (recipientProtectedMap?.get(headerLabelAlgorithm) !== AlgorithmEcdhEsHkdf256)
                throw new CoseError("Unsupported recipient algorithm.");

            const ephemeralKey = await importEphemeralKey(
                recipientUnprotected.get(headerLabelEphemeralKey)
                    ?? recipientProtectedMap?.get(headerLabelEphemeralKey),
                privateKeyCurveParameters,
            );

            const contentEncryptionKey = await deriveContentEncryptionKey(
                recipientPrivateKey,
                ephemeralKey,
                privateKeyCurveParameters.coordinateSize * 8,
                contentAlgorithm,
                contentEncryption.keyBits,
                recipientProtected,
            );

            const plaintext = await contentEncryption.decrypt(
                contentEncryptionKey,
                nonce,
                ciphertext,
                additionalData,
            );

            const keyIdentifierValue = recipientUnprotected.get(headerLabelKeyIdentifier);

            return {
                plaintext,
                contentType,
                keyIdentifier: keyIdentifierValue instanceof Uint8Array ? keyIdentifierValue : null,
                protectedHeader: contentProtectedMap,
            };
        } catch (error) {
            recipientErrors.push(error);
        }
    }

    throw new AggregateError(recipientErrors, "No usable recipient.");
}
