/*
 * Unsaved form work kept in the browser, encrypted, so that it outlives the page: a session that
 * ended and sent the browser to sign in, a tab closed, a crash. What a form holds can be the most
 * sensitive thing a page handles, and what is kept in the browser's storage outlives the session and
 * is read by whoever copies the profile, so it is kept only encrypted, under a key the page is handed
 * by its service while signed in and holds in memory alone.
 *
 * A draft is filed under the key's scope -- a fingerprint of the key, which is the account's own --
 * the form it is of, and the record that form edits, and expires a day after it was written. Where it
 * is filed is not stored as such: a record is known by a hash of it, so that a copied profile does not
 * say which forms and records the account had open. The place is bound into the encryption, so a draft
 * moved to another account's, form's or record's place, or given a later expiry, does not decrypt, and
 * is dropped as unreadable. An older draft written under the same key could still be put back in place
 * of a newer one by whoever can write the profile: nothing outside the browser keeps track of which is
 * the latest.
 */

import {decode, encode} from "../cbor/cbor.js";

/** The key, as the service hands it out: an AES-256-GCM JSON Web Key, kid naming how it was made. */
export interface DraftJwk {
    kty: string;
    alg: string;
    kid: string;
    k: string;
}

/** The key as it is held: never extractable, with what it is known by. */
export interface DraftKeyring {
    kid: string;
    scope: string;
    key: CryptoKey;
}

/** A file kept in a draft: what is known of it, and its bytes. */
export interface DraftFile {
    name: string;
    type: string;
    lastModified: number;
    bytes: Uint8Array;
}

export type DraftValue = string | DraftFile;

/**
 * What the form was drawn from: what it would have submitted as drawn from its record, and the
 * record's version where it has one. Compared with the record drawn again, it says whether the record
 * changed since the draft was written.
 */
export interface DraftBasis {
    print: string;
    version: string;
}

export interface DraftPayload {
    // The form's values in the order it submits them.
    values: [name: string, value: DraftValue][];
    // What else the page keeps of the form: rows added, choices not in its fields. Integers, strings,
    // booleans, byte arrays and arrays and plain objects of them; a number with a fraction cannot be
    // kept, and the draft is then not written.
    extra: unknown;
    basis: DraftBasis;
}

/** Which draft: the form, and the record it edits, "" for a form that creates one. */
export interface DraftId {
    form: string;
    record: string;
}

export interface Draft {
    payload: DraftPayload;
    writtenAt: number;
}

/** How long a draft is kept after it was last written. */
export const draftLifetimeMs = 86_400_000;

// The drafts, and beside them what the store sweeps by: read on every page load, the drafts
// themselves hold files, and are only read one at a time, when one is offered.
const draftsStoreName = "drafts";
const metaStoreName = "meta";
const databaseVersion = 1;
// Bound into every record's authentication, so that a record written in another layout fails to
// decrypt rather than decrypting into something misread.
const formatVersion = 1;

const textEncoder = new TextEncoder();

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]*$/.test(text))
        throw new Error("The key is not base64url.");
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4);
    return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function base64UrlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function labelledDigest(label: string, data: Uint8Array): Promise<Uint8Array> {
    const prefix = textEncoder.encode(`${label}\0`);
    const input = new Uint8Array(prefix.length + data.length);
    input.set(prefix);
    input.set(data, prefix.length);
    try {
        return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    } finally {
        // digest has taken its copy by the time it returns a promise.
        input.fill(0);
    }
}

/**
 * What a key's drafts are filed under: a fingerprint of it, which tells one account's key from
 * another's and says nothing of the key itself.
 */
export async function draftScope(rawKey: Uint8Array): Promise<string> {
    return base64UrlEncode((await labelledDigest("draft scope", rawKey)).subarray(0, 16));
}

/**
 * Takes the key the service handed out, as a key nothing can read back out of the page. The copies
 * of its bytes made here are zeroed once it is taken; the text it arrived as cannot be.
 */
export async function importDraftKey(jwk: DraftJwk): Promise<DraftKeyring> {
    if (jwk.kty !== "oct" || jwk.alg !== "A256GCM")
        throw new Error(`Not an AES-256-GCM key: ${jwk.kty} ${jwk.alg}`);
    if (!jwk.kid)
        throw new Error("The key has no id.");

    const raw = base64UrlDecode(jwk.k);
    try {
        if (raw.length !== 32)
            throw new Error(`The key is ${raw.length} bytes, not 32.`);

        const [scope, key] = await Promise.all([
            draftScope(raw),
            crypto.subtle.importKey("raw", raw, {name: "AES-GCM"}, false, ["encrypt", "decrypt"]),
        ]);
        return {kid: jwk.kid, scope, key};
    } finally {
        raw.fill(0);
    }
}

// What CBOR gives back as a Map, made the plain object it was written as.
function plain(value: unknown): unknown {
    if (value instanceof Map) {
        const object: Record<string, unknown> = {};
        for (const [key, item] of value)
            object[String(key)] = plain(item);
        return object;
    }
    if (Array.isArray(value))
        return value.map(plain);
    return value;
}

export function encodeDraftPayload(payload: DraftPayload): Uint8Array<ArrayBuffer> {
    return encode(payload);
}

export function decodeDraftPayload(bytes: Uint8Array): DraftPayload {
    const payload = plain(decode(bytes)) as DraftPayload;
    if (!Array.isArray(payload?.values) || typeof payload.basis?.print !== "string")
        throw new Error("Not a draft.");
    return payload;
}

// A draft as stored: what it is known by, and what its encryption was bound to beside its place.
interface DraftRecord {
    id: string;
    kid: string;
    writtenAt: number;
    expiresAt: number;
    iv: Uint8Array;
    ciphertext: ArrayBuffer;
}

// What the store sweeps by, small enough to be read whole on every page load.
interface MetaRecord {
    id: string;
    kid: string;
    expiresAt: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// A request that fails aborts its transaction, which says why: an error event comes first, before
// the transaction has been told the reason, so only the abort is waited for.
function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error("The transaction was aborted."));
    });
}

function openDatabase(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, databaseVersion);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(draftsStoreName))
                database.createObjectStore(draftsStoreName, {keyPath: "id"});
            if (!database.objectStoreNames.contains(metaStoreName))
                database.createObjectStore(metaStoreName, {keyPath: "id"});
        };
        request.onsuccess = () => {
            const database = request.result;
            // Another page opening a later version is let in, rather than held up by this one.
            database.onversionchange = () => database.close();
            resolve(database);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("The draft store is held open in another version."));
    });
}

export class DraftStore {
    private readonly database: IDBDatabase;
    private readonly keyring: DraftKeyring;
    private readonly now: () => number;

    private constructor(database: IDBDatabase, keyring: DraftKeyring, now: () => number) {
        this.database = database;
        this.keyring = keyring;
        this.now = now;
    }

    /**
     * Opens the store, and drops what can no longer be read: drafts expired, and drafts under a key
     * the service no longer hands out, whoever's they were.
     */
    static async open(name: string, keyring: DraftKeyring, now: () => number = Date.now): Promise<DraftStore> {
        const store = new DraftStore(await openDatabase(name), keyring, now);
        await store.sweep();
        return store;
    }

    close() {
        this.database.close();
    }

    // Where a draft is filed, as a hash of the scope, the form and the record, which says none of them.
    private async recordId(id: DraftId): Promise<string> {
        const place = textEncoder.encode(JSON.stringify([this.keyring.scope, id.form, id.record]));
        return base64UrlEncode(await labelledDigest("draft id", place));
    }

    private additionalData(id: DraftId, record: Pick<DraftRecord, "kid" | "writtenAt" | "expiresAt">) {
        return textEncoder.encode(JSON.stringify([
            formatVersion, this.keyring.scope, record.kid, id.form, id.record, record.writtenAt, record.expiresAt,
        ]));
    }

    private async sweep() {
        const transaction = this.database.transaction([metaStoreName, draftsStoreName], "readwrite");
        const metas = await requestResult(transaction.objectStore(metaStoreName).getAll() as IDBRequest<MetaRecord[]>);
        const now = this.now();
        for (const meta of metas) {
            if (meta.expiresAt <= now || meta.kid !== this.keyring.kid) {
                transaction.objectStore(metaStoreName).delete(meta.id);
                transaction.objectStore(draftsStoreName).delete(meta.id);
            }
        }
        await transactionDone(transaction);
    }

    private async deleteRecord(recordId: string): Promise<void> {
        const transaction = this.database.transaction([metaStoreName, draftsStoreName], "readwrite");
        transaction.objectStore(metaStoreName).delete(recordId);
        transaction.objectStore(draftsStoreName).delete(recordId);
        await transactionDone(transaction);
    }

    /**
     * The draft kept for a form, or null: none kept, or one that can no longer be read. One expired,
     * under another key, or that does not decrypt as its place is dropped; one that decrypts and then
     * cannot be read -- a page's own mistake -- is left for the day it is kept, rather than lost.
     */
    async get(id: DraftId): Promise<Draft | null> {
        const recordId = await this.recordId(id);
        const transaction = this.database.transaction(draftsStoreName, "readonly");
        const record = await requestResult(transaction.objectStore(draftsStoreName).get(recordId) as IDBRequest<DraftRecord | undefined>);
        if (!record)
            return null;

        let plaintext: ArrayBuffer | null = null;
        if (record.kid === this.keyring.kid && record.expiresAt > this.now()) {
            try {
                plaintext = await crypto.subtle.decrypt(
                    {name: "AES-GCM", iv: new Uint8Array(record.iv), additionalData: this.additionalData(id, record)},
                    this.keyring.key,
                    record.ciphertext,
                );
            } catch {
                plaintext = null;
            }
        }

        if (plaintext === null) {
            await this.deleteRecord(recordId);
            return null;
        }

        try {
            return {payload: decodeDraftPayload(new Uint8Array(plaintext)), writtenAt: record.writtenAt};
        } catch (error) {
            console.error("An error occurred when reading a draft: ", error);
            return null;
        }
    }

    async put(id: DraftId, payload: DraftPayload): Promise<void> {
        const recordId = await this.recordId(id);
        const writtenAt = this.now();
        const fields = {kid: this.keyring.kid, writtenAt, expiresAt: writtenAt + draftLifetimeMs};

        // Encrypted before the transaction is opened: one left waiting on anything but its own
        // requests commits itself, and the write would land in a transaction already gone.
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
            {name: "AES-GCM", iv, additionalData: this.additionalData(id, fields)},
            this.keyring.key,
            encodeDraftPayload(payload),
        );

        const transaction = this.database.transaction([metaStoreName, draftsStoreName], "readwrite");
        transaction.objectStore(draftsStoreName).put({id: recordId, ...fields, iv, ciphertext} satisfies DraftRecord);
        transaction.objectStore(metaStoreName).put({id: recordId, kid: fields.kid, expiresAt: fields.expiresAt} satisfies MetaRecord);
        await transactionDone(transaction);
    }

    async delete(id: DraftId): Promise<void> {
        await this.deleteRecord(await this.recordId(id));
    }
}

/** A form a page keeps drafts of, as the page knows it. */
export interface DraftFormSource {
    /** Which draft the form is: null while it is drawn for no record yet. */
    id(): DraftId | null;
    /** What the form holds unsaved, or null when it holds nothing unsaved. */
    snapshot(): Promise<DraftPayload | null>;
}

/** What a write found: nothing to keep, kept, or something to keep that could not be. */
export type DraftWriteOutcome = "clean" | "written" | "failed";

/**
 * The forms of a page that keep drafts, and the store they keep them in. The store is asked for at
 * every write, so the function given has to hand back the one store rather than open another, and
 * has to have started opening it while the session stood: the key is handed out only then, and the
 * write that matters most is the one made as the session ends. Null is no store, and drafts are then
 * not kept.
 */
export class DraftRegistry {
    readonly forms = new Set<FormDraft>();
    readonly store: () => Promise<DraftStore | null>;

    constructor(store: () => Promise<DraftStore | null>) {
        this.store = store;
    }

    /**
     * Writes what every form holds, for a page about to be left: whether anything was unsaved, and
     * whether all of it was kept, which is what the page can promise of restoring it.
     */
    async sessionEnded(): Promise<{unsaved: boolean; restorable: boolean}> {
        const outcomes = await Promise.all([...this.forms].map(form => form.flush()));
        return {
            unsaved: outcomes.some(outcome => outcome !== "clean"),
            restorable: outcomes.every(outcome => outcome !== "failed"),
        };
    }
}

/**
 * One form's draft: written a moment after the form last changed, and at once when asked to. Writes
 * are made one after another, so that an older snapshot never lands after a newer one.
 */
export class FormDraft {
    readonly registry: DraftRegistry;
    readonly source: DraftFormSource;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private readonly debounceMs: number;

    constructor(registry: DraftRegistry, source: DraftFormSource, options: {debounceMs?: number} = {}) {
        this.registry = registry;
        this.source = source;
        this.debounceMs = options.debounceMs ?? 500;
    }

    private async storeOrNull(): Promise<DraftStore | null> {
        try {
            return await this.registry.store();
        } catch (error) {
            console.error("An error occurred when opening the draft store: ", error);
            return null;
        }
    }

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const run = this.queue.then(work);
        this.queue = run.catch(() => {});
        return run;
    }

    private cancelTimer() {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** The form changed: its draft is written once it has been still for a moment. */
    changed(): void {
        this.cancelTimer();
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch(error => {
                console.error("An error occurred when writing a draft: ", error);
            });
        }, this.debounceMs);
    }

    /** Writes the draft now: what the form holds, or, when it holds nothing unsaved, no draft. */
    flush(): Promise<DraftWriteOutcome> {
        this.cancelTimer();
        return this.enqueue(async (): Promise<DraftWriteOutcome> => {
            const id = this.source.id();
            if (!id)
                return "clean";

            let payload: DraftPayload | null;
            try {
                payload = await this.source.snapshot();
            } catch (error) {
                console.error("An error occurred when reading what a form holds: ", error);
                return "failed";
            }

            const store = await this.storeOrNull();
            if (payload === null) {
                await store?.delete(id).catch(error => {
                    console.error("An error occurred when dropping a draft: ", error);
                });
                return "clean";
            }
            if (!store)
                return "failed";

            try {
                await store.put(id, payload);
                return "written";
            } catch (error) {
                console.error("An error occurred when writing a draft: ", error);
                return "failed";
            }
        });
    }

    /** Drops the draft, for a form saved or discarded, after any write already under way. */
    clear(): Promise<void> {
        this.cancelTimer();
        return this.enqueue(async () => {
            const id = this.source.id();
            const store = await this.storeOrNull();
            if (id && store) {
                await store.delete(id).catch(error => {
                    console.error("An error occurred when dropping a draft: ", error);
                });
            }
        });
    }

    /** The draft kept for the form as it is drawn now, for the page to offer back. */
    offer(): Promise<Draft | null> {
        return this.enqueue(async () => {
            const id = this.source.id();
            const store = await this.storeOrNull();
            return id && store ? store.get(id) : null;
        });
    }

    /** Counts the form among the page's, so that it is written when the session ends. */
    attach(): void {
        this.registry.forms.add(this);
    }

    /**
     * No longer counts the form, once what it holds is written: a write pending is made, and one
     * under way finished, before the page takes the form down.
     */
    async detach(): Promise<void> {
        const pending = this.timer !== null;
        this.registry.forms.delete(this);
        if (pending)
            await this.flush();
        await this.enqueue(async () => {});
    }
}
