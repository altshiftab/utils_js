import assert from "node:assert/strict";
import {afterEach, beforeEach, mock, test} from "node:test";

import {
    type DraftId,
    type DraftJwk,
    type DraftPayload,
    DraftRegistry,
    DraftStore,
    FormDraft,
    draftLifetimeMs,
    importDraftKey,
} from "../src/browser/drafts.js";
import {installIndexedDb, type IndexedDbStub} from "./indexeddb_stub.js";

let indexedDb: IndexedDbStub;

beforeEach(() => {
    indexedDb = installIndexedDb();
});

afterEach(() => {
    indexedDb.restore();
});

const databaseName = "drafts-test";

function jwk(seed: number, kid = "v1.test"): DraftJwk {
    const bytes = Uint8Array.from({length: 32}, (_, i) => (seed + i) & 0xff);
    const k = Buffer.from(bytes).toString("base64url");
    return {kty: "oct", alg: "A256GCM", kid, k};
}

function records(): Map<string, Record<string, any>> {
    return indexedDb.databases.get(databaseName)!.get("drafts") as Map<string, Record<string, any>>;
}

function metas(): Map<string, Record<string, any>> {
    return indexedDb.databases.get(databaseName)!.get("meta") as Map<string, Record<string, any>>;
}

const orderId: DraftId = {form: "order-details", record: "customer-1/order-1"};

// A payload of each kind of thing a draft keeps: text, two files, the page's own state, and what
// the form was drawn from.
const payload: DraftPayload = {
    values: [
        ["name", "Ada Lovelace"],
        ["passport", {name: "passport.pdf", type: "application/pdf", lastModified: 1_700_000_000_000, bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 1, 2, 3])}],
        ["passport", {name: "visa.pdf", type: "application/pdf", lastModified: 1_700_000_000_001, bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 4])}],
        ["notes", "Line one\nLine two"],
    ],
    extra: {deleted: ["old.pdf"], editing: true, rows: [{company: "Acme", current: false}]},
    basis: {print: "[[\"name\",\"\"]]", version: "2026-11-04T12:00:00Z"},
};

test("a key is taken as one nothing can read back, known by its id and an account's scope", async () => {
    const keyring = await importDraftKey(jwk(1));

    assert.equal(keyring.kid, "v1.test");
    assert.equal(keyring.key.extractable, false);
    assert.deepEqual(keyring.key.usages.toSorted(), ["decrypt", "encrypt"]);

    // The scope is the key's: the same key, at the next sign-in, files under the same; another
    // account's key under another.
    assert.equal((await importDraftKey(jwk(1))).scope, keyring.scope);
    assert.notEqual((await importDraftKey(jwk(2))).scope, keyring.scope);
});

test("a key that is not an AES-256-GCM one is refused", async () => {
    const testCases: {name: string; jwk: DraftJwk}[] = [
        {name: "another key type", jwk: {...jwk(1), kty: "RSA"}},
        {name: "another algorithm", jwk: {...jwk(1), alg: "A128GCM"}},
        {name: "a short key", jwk: {...jwk(1), k: Buffer.alloc(16).toString("base64url")}},
        {name: "not base64url", jwk: {...jwk(1), k: "not base64url!"}},
        {name: "no id", jwk: {...jwk(1), kid: ""}},
    ];

    for (const testCase of testCases)
        await assert.rejects(importDraftKey(testCase.jwk), Error, testCase.name);
});

test("a draft kept is the draft given back", async () => {
    const store = await DraftStore.open(databaseName, await importDraftKey(jwk(1)), () => 5_000);

    await store.put(orderId, payload);
    const draft = await store.get(orderId);

    assert.deepEqual(draft, {payload, writtenAt: 5_000});
});

test("what is stored is encrypted, under a fresh nonce each time", async () => {
    const keyring = await importDraftKey(jwk(1));
    const store = await DraftStore.open(databaseName, keyring);

    await store.put(orderId, payload);
    const first = structuredClone([...records().values()][0]!);
    await store.put(orderId, payload);
    const second = [...records().values()][0]!;

    assert.equal(first.kid, keyring.kid);
    assert.equal(first.iv.length, 12);
    assert.notDeepEqual(first.iv, second.iv);

    // Nothing typed into the form is readable in what is stored.
    const stored = Buffer.from(first.ciphertext as ArrayBuffer);
    for (const cleartext of ["Ada Lovelace", "Line one", "passport.pdf", "Acme"])
        assert.equal(stored.includes(Buffer.from(cleartext)), false, cleartext);

    // Nor where it is filed: which form, which record, whose.
    const everything = JSON.stringify([...records().entries(), ...metas().entries()], (_key, value) =>
        value instanceof Uint8Array || value instanceof ArrayBuffer ? "(bytes)" : value);
    for (const place of [orderId.form, orderId.record, "customer-1", keyring.scope])
        assert.equal(everything.includes(place), false, place);
    assert.deepEqual(Object.keys(first).toSorted(), ["ciphertext", "expiresAt", "id", "iv", "kid", "writtenAt"]);
});

/*
 * A record's place is bound into its encryption: one moved to another record's place, given a later
 * expiry or another time, does not decrypt there, and is dropped rather than offered.
 */
test("a draft moved or altered is unreadable, and dropped", async () => {
    const elsewhere = {
        record: {form: orderId.form, record: "customer-1/order-2"},
        form: {form: "candidate-details", record: orderId.record},
    };
    const testCases: {name: string; target: DraftId; alter: (record: Record<string, any>) => Record<string, any>}[] = [
        {name: "moved to another record", target: elsewhere.record, alter: record => record},
        {name: "moved to another form", target: elsewhere.form, alter: record => record},
        {name: "kept longer", target: orderId, alter: record => ({...record, expiresAt: record.expiresAt + draftLifetimeMs})},
        {name: "dated later", target: orderId, alter: record => ({...record, writtenAt: record.writtenAt + 1})},
        {name: "said to be under the key it was under, and altered", target: orderId, alter: record => {
            const ciphertext = new Uint8Array(record.ciphertext.slice(0));
            ciphertext[0]! ^= 1;
            return {...record, ciphertext: ciphertext.buffer};
        }},
    ];

    for (const testCase of testCases) {
        indexedDb.restore();
        indexedDb = installIndexedDb();

        const store = await DraftStore.open(databaseName, await importDraftKey(jwk(1)));
        await store.put(orderId, payload);
        const original = [...records().values()][0]!;

        // The target's slot is found by writing to it; the original is then put there in its place.
        if (testCase.target !== orderId)
            await store.put(testCase.target, payload);
        const targetId = testCase.target === orderId
            ? original.id
            : [...records().keys()].find(key => key !== original.id)!;
        records().set(targetId, {...testCase.alter(original), id: targetId});

        assert.equal(await store.get(testCase.target), null, testCase.name);
        assert.equal(records().has(targetId), false, `${testCase.name}: dropped`);
        assert.equal(metas().has(targetId), false, `${testCase.name}: and its sweeping record with it`);
    }
});

test("a draft said to be under another key is dropped", async () => {
    const store = await DraftStore.open(databaseName, await importDraftKey(jwk(1)));
    await store.put(orderId, payload);
    const record = [...records().values()][0]!;
    records().set(record.id, {...record, kid: "v1.other"});

    assert.equal(await store.get(orderId), null);
    assert.equal(records().size, 0);
});

test("another account's key reads nothing of a draft, even put in its place", async () => {
    const own = await importDraftKey(jwk(1));
    const other = await importDraftKey(jwk(2));

    await (await DraftStore.open(databaseName, own)).put(orderId, payload);
    const otherStore = await DraftStore.open(databaseName, other);

    // Filed under the account's scope, it is not found under the other's.
    assert.equal(await otherStore.get(orderId), null);
    assert.equal(records().size, 1, "and is left for its account");

    // Copied into the other's place, it does not decrypt under the other's key.
    const record = [...records().values()][0]!;
    await otherStore.put(orderId, payload);
    const otherPlace = [...records().keys()].find(key => key !== record.id)!;
    records().set(otherPlace, {...record, id: otherPlace});
    assert.equal(await otherStore.get(orderId), null);
    assert.equal(records().has(otherPlace), false);
    assert.equal(records().has(record.id), true, "and the account's own is left");
});

test("a draft past its time is dropped, when asked for and when the store is opened", async () => {
    let now = 1_000;
    const keyring = await importDraftKey(jwk(1));
    const store = await DraftStore.open(databaseName, keyring, () => now);

    await store.put(orderId, payload);
    await store.put({form: "report", record: ""}, payload);

    now += draftLifetimeMs - 1;
    assert.notEqual(await store.get(orderId), null, "still within its time");

    now += 1;
    assert.equal(await store.get(orderId), null, "asked for after it");
    assert.equal(records().size, 1);

    await DraftStore.open(databaseName, keyring, () => now);
    assert.equal(records().size, 0, "and the rest when the store is next opened");
    assert.equal(metas().size, 0);
});

test("a draft is kept for a week", () => {
    assert.equal(draftLifetimeMs, 7 * 24 * 60 * 60 * 1000);
});

test("drafts under a key no longer handed out are dropped when the store is opened", async () => {
    await (await DraftStore.open(databaseName, await importDraftKey(jwk(1, "v1.old")))).put(orderId, payload);
    await (await DraftStore.open(databaseName, await importDraftKey(jwk(2, "v1.old")))).put(orderId, payload);
    assert.equal(records().size, 2);

    // The secret behind the keys was replaced: every account's drafts under it are unreadable now.
    await DraftStore.open(databaseName, await importDraftKey(jwk(1, "v1.new")));

    assert.equal(records().size, 0);
    assert.equal(metas().size, 0);
});

/** A form whose snapshot the test sets, as a page's would follow what is typed. */
function source(id: DraftId | null = orderId) {
    const state = {snapshot: payload as DraftPayload | null, snapshots: 0};
    return {
        state,
        source: {
            id: () => id,
            snapshot: async () => {
                state.snapshots++;
                return state.snapshot;
            },
        },
    };
}

/** A store counting what is asked of it, and failing writes when told to. */
async function countingStore() {
    const store = await DraftStore.open(databaseName, await importDraftKey(jwk(1)));
    const counts = {put: 0, delete: 0, failing: false};
    const put = store.put.bind(store);
    const remove = store.delete.bind(store);
    store.put = async (id, value) => {
        counts.put++;
        if (counts.failing)
            throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return put(id, value);
    };
    store.delete = async id => {
        counts.delete++;
        return remove(id);
    };
    return {store, counts};
}

test("a form's draft is written once it has been still a moment, and at once when asked", async t => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const {store, counts} = await countingStore();
    const form = source();
    const draft = new FormDraft(new DraftRegistry(async () => store), form.source, {debounceMs: 500});

    draft.changed();
    t.mock.timers.tick(400);
    draft.changed();
    t.mock.timers.tick(400);
    assert.equal(counts.put, 0, "not while it is still changing");

    t.mock.timers.tick(100);
    // Asked for after the write the moment's passing started, so answered once it is done.
    assert.notEqual(await draft.offer(), null);
    assert.equal(counts.put, 1, "once, when it has been still");

    // Asked to, it writes at once, without waiting out the moment.
    draft.changed();
    assert.equal(await draft.flush(), "written");
    assert.equal(counts.put, 2);

    // A form undone back to what it was drawn with holds nothing unsaved: its draft is dropped.
    form.state.snapshot = null;
    assert.equal(await draft.flush(), "clean");
    assert.equal(await store.get(orderId), null);
});

test("a saved form's draft is dropped, a pending write with it", async t => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const {store, counts} = await countingStore();
    const draft = new FormDraft(new DraftRegistry(async () => store), source().source);

    await draft.flush();
    draft.changed();
    await draft.clear();
    t.mock.timers.tick(1_000);
    await draft.offer();

    assert.equal(counts.put, 1, "the write pending when it was saved is not made");
    assert.equal(await draft.offer(), null);
});

test("a form taken off the page writes what it had pending, and is no longer counted", async t => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const {store, counts} = await countingStore();
    const registry = new DraftRegistry(async () => store);
    const draft = new FormDraft(registry, source().source);

    draft.attach();
    assert.equal(registry.forms.size, 1);

    draft.changed();
    await draft.detach();

    assert.equal(counts.put, 1);
    assert.equal(registry.forms.size, 0);
});

test("a form drawn for no record yet keeps no draft", async () => {
    const {store, counts} = await countingStore();
    const draft = new FormDraft(new DraftRegistry(async () => store), source(null).source);

    assert.equal(await draft.flush(), "clean");
    assert.equal(await draft.offer(), null);
    assert.equal(counts.put, 0);
});

/*
 * What the page can say when its session ends: whether anything was unsaved, and whether all of it
 * was kept, which is what a promise that it can be restored rests on.
 */
test("the session's end is told what was unsaved, and whether it was all kept", async () => {
    const testCases: {
        name: string;
        dirty: boolean;
        store: "working" | "none" | "failing";
        expected: {unsaved: boolean; restorable: boolean};
    }[] = [
        {name: "nothing unsaved", dirty: false, store: "working", expected: {unsaved: false, restorable: true}},
        {name: "unsaved, and kept", dirty: true, store: "working", expected: {unsaved: true, restorable: true}},
        {name: "unsaved, with no store to keep it in", dirty: true, store: "none", expected: {unsaved: true, restorable: false}},
        {name: "unsaved, and the write refused", dirty: true, store: "failing", expected: {unsaved: true, restorable: false}},
    ];

    for (const testCase of testCases) {
        indexedDb.restore();
        indexedDb = installIndexedDb();

        const {store, counts} = await countingStore();
        counts.failing = testCase.store === "failing";
        const registry = new DraftRegistry(async () => testCase.store === "none" ? null : store);

        const clean = source({form: "customer", record: "c1"});
        clean.state.snapshot = null;
        new FormDraft(registry, clean.source).attach();

        const edited = source();
        edited.state.snapshot = testCase.dirty ? payload : null;
        new FormDraft(registry, edited.source).attach();

        assert.deepEqual(await registry.sessionEnded(), testCase.expected, testCase.name);
    }
});

test("a store that cannot be opened is no store, and refuses nothing", async () => {
    indexedDb.failOpen = true;
    await assert.rejects(DraftStore.open(databaseName, await importDraftKey(jwk(1))));

    const registry = new DraftRegistry(() => DraftStore.open(databaseName, {} as never));
    const draft = new FormDraft(registry, source().source);
    draft.attach();

    assert.equal(await draft.offer(), null);
    assert.deepEqual(await registry.sessionEnded(), {unsaved: true, restorable: false});
});

test("a draft that decrypts and cannot be read is kept, not dropped", async () => {
    const store = await DraftStore.open(databaseName, await importDraftKey(jwk(1)));
    mock.method(console, "error", () => {});

    // Written under the key, so authentic: a page's own mistake, which is no reason to lose it.
    await store.put(orderId, {values: "not a list", basis: {print: "", version: ""}} as unknown as DraftPayload);

    assert.equal(await store.get(orderId), null);
    assert.equal(records().size, 1);
});

test("a draft the store refuses, or that cannot be written down, is a failed write", async () => {
    const testCases: {name: string; refuse: boolean; extra: unknown}[] = [
        {name: "the disk full", refuse: true, extra: null},
        {name: "a number with a fraction in what the page keeps", refuse: false, extra: {ratio: 0.5}},
    ];

    for (const testCase of testCases) {
        indexedDb.restore();
        indexedDb = installIndexedDb();
        mock.method(console, "error", () => {});

        const store = await DraftStore.open(databaseName, await importDraftKey(jwk(1)));
        indexedDb.failWrites = testCase.refuse;
        const form = source();
        form.state.snapshot = {...payload, extra: testCase.extra};

        const draft = new FormDraft(new DraftRegistry(async () => store), form.source);

        assert.equal(await draft.flush(), "failed", testCase.name);
        // A transaction refused is undone whole: no record half written.
        assert.equal(records().size, 0, testCase.name);
        assert.equal(metas().size, 0, testCase.name);
        mock.restoreAll();
    }
});

test("a draft cleared after a write is asked for, without waiting for it, is gone", async () => {
    const {store} = await countingStore();
    const draft = new FormDraft(new DraftRegistry(async () => store), source().source);

    void draft.flush();
    await draft.clear();

    assert.equal(await store.get(orderId), null);
});

test("a form taken off the page waits for the write already under way", async () => {
    const {store} = await countingStore();
    let release!: () => void;
    const held = new Promise<void>(resolve => {
        release = resolve;
    });
    const draft = new FormDraft(new DraftRegistry(async () => store), {
        id: () => orderId,
        snapshot: async () => {
            await held;
            return payload;
        },
    });

    void draft.flush();
    let detached = false;
    const detaching = draft.detach().then(() => {
        detached = true;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(detached, false, "not while the write is under way");

    release();
    await detaching;
    assert.notEqual(await store.get(orderId), null, "and the write is made");
});
