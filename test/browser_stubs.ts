/**
 * Minimal stand-ins for the browser globals the `src/browser` modules reach for. Only the surface
 * those modules actually touch is implemented; anything else is intentionally absent so that a
 * module growing a new dependency on the environment shows up as a failure here.
 */

export type Listener = (event: any) => unknown;

export class LocationStub {
    reloadCount = 0;
    hrefAssignments: string[] = [];
    #url: URL;

    constructor(href: string) {
        this.#url = new URL(href);
    }

    get href() {
        return this.#url.href;
    }

    set href(value: string) {
        this.hrefAssignments.push(value);
        this.#url = new URL(value, this.#url);
    }

    get pathname() {
        return this.#url.pathname;
    }

    reload() {
        this.reloadCount++;
    }
}

export interface FetchCall {
    input: unknown;
    init: RequestInit | undefined;
}

export interface StubOptions {
    href?: string;
    // Omitted leaves `startViewTransition` off `document`, as in a browser without the API.
    viewTransitions?: boolean;
    reducedMotion?: boolean;
    navigation?: boolean;
    respond?: (call: FetchCall) => Response | Promise<Response>;
}

export interface Stubs {
    fetchCalls: FetchCall[];
    intervals: {callback: () => unknown; ms: number | undefined}[];
    location: LocationStub;
    sessionStorageData: Map<string, string>;
    visibilityState: DocumentVisibilityState;
    now: number;
    transitionCount: number;
    dispatch(type: string, event?: unknown): Promise<void>;
    dispatchDocument(type: string, event?: unknown): Promise<void>;
    dispatchNavigate(event: unknown): Promise<void>;
    restore(): void;
}

function globals() {
    return globalThis as unknown as Record<string, unknown>;
}

export function installStubs(options: StubOptions = {}): Stubs {
    const {
        href = "https://example.test/",
        viewTransitions = false,
        reducedMotion = false,
        navigation = false,
        respond = () => new Response(null, {status: 204}),
    } = options;

    const names = [
        "addEventListener", "document", "window", "location", "matchMedia",
        "sessionStorage", "setInterval", "fetch", "Date",
    ];
    const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);

    const listeners = new Map<string, Listener[]>();
    const documentListeners = new Map<string, Listener[]>();
    const navigateListeners = new Map<string, Listener[]>();

    function add(map: Map<string, Listener[]>) {
        return (type: string, listener: Listener) => {
            const existing = map.get(type);
            if (existing) {
                existing.push(listener);
            } else {
                map.set(type, [listener]);
            }
        };
    }

    async function fire(map: Map<string, Listener[]>, type: string, event: unknown) {
        for (const listener of map.get(type) ?? [])
            await listener(event);
    }

    const stubs: Stubs = {
        fetchCalls: [],
        intervals: [],
        location: new LocationStub(href),
        sessionStorageData: new Map(),
        visibilityState: "visible",
        now: 1_000_000,
        transitionCount: 0,
        dispatch: (type, event) => fire(listeners, type, event),
        dispatchDocument: (type, event) => fire(documentListeners, type, event),
        dispatchNavigate: event => fire(navigateListeners, "navigate", event),
        restore() {
            for (const [name, descriptor] of saved) {
                if (descriptor) {
                    Object.defineProperty(globalThis, name, descriptor);
                } else {
                    delete globals()[name];
                }
            }
        },
    };

    const documentStub: Record<string, unknown> = {
        addEventListener: add(documentListeners),
        get visibilityState() {
            return stubs.visibilityState;
        },
    };

    if (viewTransitions) {
        documentStub.startViewTransition = (callback: () => unknown) => {
            stubs.transitionCount++;
            return {updateCallbackDone: Promise.resolve(callback())};
        };
    }

    const windowStub: Record<string, unknown> = {location: stubs.location};
    if (navigation)
        windowStub.navigation = {addEventListener: add(navigateListeners)};

    Object.assign(globals(), {
        addEventListener: add(listeners),
        document: documentStub,
        window: windowStub,
        location: stubs.location,
        matchMedia: (query: string) => ({
            media: query,
            matches: reducedMotion && query.includes("prefers-reduced-motion"),
        }),
        sessionStorage: {
            getItem: (key: string) => stubs.sessionStorageData.get(key) ?? null,
            setItem: (key: string, value: string) => void stubs.sessionStorageData.set(key, value),
            removeItem: (key: string) => void stubs.sessionStorageData.delete(key),
        },
        // Captured rather than scheduled: `refreshSession` never surrenders the handle, so a real
        // interval would outlive the test and keep the runner alive.
        setInterval: (callback: () => unknown, ms?: number) => {
            stubs.intervals.push({callback, ms});
            return stubs.intervals.length;
        },
        fetch: (input: unknown, init?: RequestInit) => {
            const call = {input, init};
            stubs.fetchCalls.push(call);
            return Promise.resolve(respond(call));
        },
    });

    // Only `Date.now` is redirected; the rest of `Date` stays intact.
    const RealDate = saved.find(([name]) => name === "Date")?.[1]?.value as DateConstructor;
    globals().Date = new Proxy(RealDate, {
        get: (target, property, receiver) =>
            property === "now" ? () => stubs.now : Reflect.get(target, property, receiver),
    });

    return stubs;
}

export function readBody(call: FetchCall): any {
    return JSON.parse(String(call.init?.body));
}

/** Lets the pending microtask queue drain, for paths that never settle a promise of their own. */
export async function tick(count = 2): Promise<void> {
    for (let i = 0; i < count; i++)
        await new Promise(resolve => setImmediate(resolve));
}
