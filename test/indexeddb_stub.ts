/**
 * A stand-in for IndexedDB, as much of it as `src/browser/drafts.ts` reaches for, modelling what the
 * real one does that the code depends on:
 *
 * - what is put is copied as structured cloning copies it, and so is what is read, so that a value
 *   changed after it was put, or a result changed after it was read, does not change what is stored;
 * - a request settles in a task of its own, and a transaction commits once a task has passed with no
 *   request of it pending, after which it takes none: a write made after awaiting something else, in
 *   a transaction opened before, fails here as it does in a browser;
 * - a request that fails fires its error, and then aborts its transaction, which undoes the
 *   transaction's writes and fires abort, with the transaction's error set, rather than complete.
 */

type Records = Map<string, unknown>;

class FakeRequest<T> {
    result: T | undefined = undefined;
    error: unknown = null;
    onsuccess: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onupgradeneeded: ((event: unknown) => void) | null = null;
    onblocked: ((event: unknown) => void) | null = null;
}

class FakeTransaction {
    private pending = 0;
    private finished = false;
    // What each write replaced, so that an abort can put it back.
    private readonly journal: (() => void)[] = [];
    error: unknown = null;
    oncomplete: (() => void) | null = null;
    onabort: (() => void) | null = null;

    constructor(
        private readonly stores: Map<string, Records>,
        private readonly keyPaths: Map<string, string>,
        private readonly scope: string[],
        private readonly writable: boolean,
        private readonly stub: IndexedDbStub,
    ) {
        this.scheduleCommit();
    }

    private scheduleCommit() {
        setImmediate(() => {
            if (this.pending === 0 && !this.finished) {
                this.finished = true;
                this.oncomplete?.();
            }
        });
    }

    private abort(error: unknown) {
        if (this.finished)
            return;
        this.finished = true;
        for (const undo of this.journal.toReversed())
            undo();
        this.error = error;
        this.onabort?.();
    }

    private request<T>(work: () => T, writes: boolean): FakeRequest<T> {
        if (this.finished)
            throw new DOMException("The transaction has finished.", "TransactionInactiveError");
        if (writes && !this.writable)
            throw new DOMException("The transaction is read-only.", "ReadOnlyError");

        this.pending++;
        const request = new FakeRequest<T>();
        setImmediate(() => {
            this.pending--;
            if (this.finished)
                return;
            try {
                if (writes && this.stub.failWrites)
                    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
                request.result = work();
                request.onsuccess?.({target: request});
            } catch (error) {
                request.error = error;
                request.onerror?.({target: request});
                this.abort(error);
                return;
            }
            this.scheduleCommit();
        });
        return request;
    }

    private records(name: string): Records {
        if (!this.scope.includes(name))
            throw new DOMException(`${name} is not in the transaction.`, "NotFoundError");
        return this.stores.get(name)!;
    }

    private remember(records: Records, key: string) {
        const existed = records.has(key);
        const previous = records.get(key);
        this.journal.push(() => existed ? records.set(key, previous) : records.delete(key));
    }

    objectStore(name: string) {
        const records = this.records(name);
        const keyPath = this.keyPaths.get(name)!;
        return {
            get: (key: string) => this.request(() => structuredClone(records.get(key)), false),
            getAll: () => this.request(() => [...records.values()].map(value => structuredClone(value)), false),
            put: (value: Record<string, unknown>) => this.request(() => {
                const key = String(value[keyPath]);
                this.remember(records, key);
                records.set(key, structuredClone(value));
                return key;
            }, true),
            delete: (key: string) => this.request(() => {
                this.remember(records, key);
                records.delete(key);
            }, true),
        };
    }
}

export interface IndexedDbStub {
    // Each database's object stores, by database name and then store name, holding the records as
    // stored.
    databases: Map<string, Map<string, Records>>;
    // Makes open fail, as a browser refusing storage does.
    failOpen: boolean;
    // Makes every write fail, as a full disk does.
    failWrites: boolean;
    restore(): void;
}

export function installIndexedDb(): IndexedDbStub {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

    const stub: IndexedDbStub = {
        databases: new Map(),
        failOpen: false,
        failWrites: false,
        restore() {
            if (saved) {
                Object.defineProperty(globalThis, "indexedDB", saved);
            } else {
                delete (globalThis as unknown as Record<string, unknown>).indexedDB;
            }
        },
    };

    const keyPaths = new Map<string, Map<string, string>>();

    (globalThis as unknown as Record<string, unknown>).indexedDB = {
        open(name: string, _version: number) {
            const request = new FakeRequest<unknown>();
            setImmediate(() => {
                if (stub.failOpen) {
                    request.error = new DOMException("Storage is not allowed.", "SecurityError");
                    request.onerror?.({target: request});
                    return;
                }

                const isNew = !stub.databases.has(name);
                const stores = stub.databases.get(name) ?? new Map<string, Records>();
                stub.databases.set(name, stores);
                const paths = keyPaths.get(name) ?? new Map<string, string>();
                keyPaths.set(name, paths);

                const database = {
                    onversionchange: null as (() => void) | null,
                    objectStoreNames: {contains: (store: string) => stores.has(store)},
                    createObjectStore(store: string, options: {keyPath: string}) {
                        stores.set(store, new Map());
                        paths.set(store, options.keyPath);
                    },
                    transaction(scope: string | string[], mode: string) {
                        const names = Array.isArray(scope) ? scope : [scope];
                        for (const store of names) {
                            if (!stores.has(store))
                                throw new DOMException(`No object store ${store}.`, "NotFoundError");
                        }
                        return new FakeTransaction(stores, paths, names, mode === "readwrite", stub);
                    },
                    close() {},
                };

                request.result = database;
                if (isNew)
                    request.onupgradeneeded?.({target: request});
                request.onsuccess?.({target: request});
            });
            return request;
        },
    };

    return stub;
}
