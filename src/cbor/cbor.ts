/**
 * Minimal CBOR (RFC 8949) codec covering the subset used by COSE structures: integers, byte
 * strings, text strings, arrays, maps, tags, booleans, null, and undefined. Encoding is
 * deterministic (definite lengths, minimal integer encoding, bytewise-sorted map keys);
 * indefinite lengths and floating-point values are rejected.
 */

export class CborError extends Error {}

export class CborTag {
    constructor(public readonly tag: number, public readonly value: unknown) {}
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", {fatal: true});

function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
        if (a[i] !== b[i])
            return a[i]! - b[i]!;
    }
    return a.length - b.length;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

function encodeTypeAndArgument(majorType: number, argument: number): Uint8Array {
    if (!Number.isSafeInteger(argument) || argument < 0)
        throw new CborError(`Invalid argument: ${argument}`);

    if (argument < 24)
        return new Uint8Array([(majorType << 5) | argument]);

    if (argument <= 0xff)
        return new Uint8Array([(majorType << 5) | 24, argument]);

    if (argument <= 0xffff)
        return new Uint8Array([(majorType << 5) | 25, argument >>> 8, argument & 0xff]);

    if (argument <= 0xffffffff) {
        const bytes = new Uint8Array(5);
        bytes[0] = (majorType << 5) | 26;
        new DataView(bytes.buffer).setUint32(1, argument);
        return bytes;
    }

    const bytes = new Uint8Array(9);
    bytes[0] = (majorType << 5) | 27;
    new DataView(bytes.buffer).setBigUint64(1, BigInt(argument));
    return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null)
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function encodeMapEntries(entries: [unknown, unknown][], chunks: Uint8Array[]): void {
    const encodedEntries: [Uint8Array, Uint8Array][] = [];
    for (const [key, item] of entries)
        encodedEntries.push([encode(key), encode(item)]);
    encodedEntries.sort((a, b) => compareBytes(a[0], b[0]));

    chunks.push(encodeTypeAndArgument(5, encodedEntries.length));
    for (const [keyBytes, itemBytes] of encodedEntries)
        chunks.push(keyBytes, itemBytes);
}

function encodeItem(value: unknown, chunks: Uint8Array[]): void {
    if (value === null) {
        chunks.push(new Uint8Array([0xf6]));
    } else if (value === undefined) {
        chunks.push(new Uint8Array([0xf7]));
    } else if (typeof value === "boolean") {
        chunks.push(new Uint8Array([value ? 0xf5 : 0xf4]));
    } else if (typeof value === "number") {
        if (!Number.isSafeInteger(value))
            throw new CborError(`Unsupported number: ${value}`);
        if (value >= 0)
            chunks.push(encodeTypeAndArgument(0, value));
        else
            chunks.push(encodeTypeAndArgument(1, -value - 1));
    } else if (typeof value === "string") {
        const bytes = textEncoder.encode(value);
        chunks.push(encodeTypeAndArgument(3, bytes.length), bytes);
    } else if (value instanceof Uint8Array) {
        chunks.push(encodeTypeAndArgument(2, value.length), value);
    } else if (Array.isArray(value)) {
        chunks.push(encodeTypeAndArgument(4, value.length));
        for (const item of value)
            encodeItem(item, chunks);
    } else if (value instanceof Map) {
        encodeMapEntries([...value.entries()], chunks);
    } else if (value instanceof CborTag) {
        chunks.push(encodeTypeAndArgument(6, value.tag));
        encodeItem(value.value, chunks);
    } else if (isPlainObject(value)) {
        // Plain objects encode as text-keyed maps; properties with an undefined value are
        // omitted, mirroring JSON.stringify and optional interface properties.
        const entries: [unknown, unknown][] = [];
        for (const [key, item] of Object.entries(value)) {
            if (item !== undefined)
                entries.push([key, item]);
        }
        encodeMapEntries(entries, chunks);
    } else {
        throw new CborError(`Unsupported value type: ${typeof value}`);
    }
}

export function encode(value: unknown): Uint8Array<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    encodeItem(value, chunks);
    return concatChunks(chunks);
}

class Decoder {
    private offset = 0;
    private readonly view: DataView;

    constructor(private readonly data: Uint8Array) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    private readTypeAndArgument(): [number, number, number] {
        if (this.offset >= this.data.length)
            throw new CborError("Unexpected end of data.");

        const initialByte = this.data[this.offset++]!;
        const majorType = initialByte >> 5;
        const additionalInformation = initialByte & 0x1f;

        if (additionalInformation < 24)
            return [majorType, additionalInformation, additionalInformation];

        if (additionalInformation === 31)
            throw new CborError("Indefinite lengths are not supported.");

        if (additionalInformation > 27)
            throw new CborError(`Malformed additional information: ${additionalInformation}`);

        const argumentSize = 1 << (additionalInformation - 24);
        if (this.offset + argumentSize > this.data.length)
            throw new CborError("Unexpected end of data.");

        let argument: number;
        switch (additionalInformation) {
            case 24:
                argument = this.view.getUint8(this.offset);
                break;
            case 25:
                argument = this.view.getUint16(this.offset);
                break;
            case 26:
                argument = this.view.getUint32(this.offset);
                break;
            default: {
                const bigArgument = this.view.getBigUint64(this.offset);
                if (bigArgument > BigInt(Number.MAX_SAFE_INTEGER))
                    throw new CborError(`Unsupported argument: ${bigArgument}`);
                argument = Number(bigArgument);
                break;
            }
        }

        this.offset += argumentSize;
        return [majorType, argument, additionalInformation];
    }

    private readBytes(length: number): Uint8Array {
        if (this.offset + length > this.data.length)
            throw new CborError("Unexpected end of data.");

        const bytes = this.data.slice(this.offset, this.offset + length);
        this.offset += length;
        return bytes;
    }

    decodeItem(): unknown {
        const [majorType, argument, additionalInformation] = this.readTypeAndArgument();

        switch (majorType) {
            case 0:
                return argument;
            case 1:
                return -argument - 1;
            case 2:
                return this.readBytes(argument);
            case 3:
                return textDecoder.decode(this.readBytes(argument));
            case 4: {
                const array: unknown[] = [];
                for (let i = 0; i < argument; i++)
                    array.push(this.decodeItem());
                return array;
            }
            case 5: {
                const map = new Map<unknown, unknown>();
                for (let i = 0; i < argument; i++) {
                    const key = this.decodeItem();
                    if (map.has(key))
                        throw new CborError("Duplicate map key.");
                    map.set(key, this.decodeItem());
                }
                return map;
            }
            case 6:
                return new CborTag(argument, this.decodeItem());
            default:
                if (additionalInformation >= 24)
                    throw new CborError("Floats and extended simple values are not supported.");
                switch (argument) {
                    case 20:
                        return false;
                    case 21:
                        return true;
                    case 22:
                        return null;
                    case 23:
                        return undefined;
                    default:
                        throw new CborError(`Unsupported simple value: ${argument}`);
                }
        }
    }

    finish(): void {
        if (this.offset !== this.data.length)
            throw new CborError("Trailing data.");
    }
}

export function decode(data: Uint8Array): unknown {
    const decoder = new Decoder(data);
    const value = decoder.decodeItem();
    decoder.finish();
    return value;
}
