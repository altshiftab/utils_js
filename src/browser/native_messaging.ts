/**
 * A request/response port to a native application.
 *
 * `runtime.connectNative` gives a duplex message stream, not a call: messages arrive whenever the
 * host sends them, in whatever order it answers. An extension that only ever has one question
 * outstanding can ignore that, and the extensions here have so far. One that asks again before the
 * first answer arrives -- a checker firing as someone types, say -- cannot, because the second
 * reply is indistinguishable from the first without something in the message to tell them apart.
 *
 * So every request carries an `id` and the host is required to echo it back. That is a contract
 * with the native side rather than a browser feature; a host that drops the field will have its
 * replies discarded as unmatched, which is at least a failure that reads as one.
 *
 * The port is opened on the first request and kept, since opening one starts a process, and an
 * extension that reconnected per request would pay a process start on every keystroke.
 *
 * Giving up on a request -- an abort, a timeout -- stops this side listening and nothing more. The
 * host has no idea and goes on working, which for a host that is spending money or minutes on the
 * question is a request paid for and thrown away. `cancelMessage` is how a caller says so, and it
 * is the caller's shape rather than one imposed here: native messaging has no cancellation to
 * conform to, and requiring every host to understand one invented here would be a tax on the hosts
 * that have nothing to cancel.
 */

/** The part of a `runtime.Port` used here. Narrow so a test can supply one without a browser. */
export interface PortLike {
    postMessage(message: unknown): void;
    disconnect(): void;
    onMessage: {addListener(listener: (message: unknown) => void): void};
    onDisconnect: {addListener(listener: () => void): void};
    error?: {message?: string} | null;
}

/** The part of `browser.runtime` used here. */
export interface RuntimeLike {
    connectNative(name: string): PortLike;
    lastError?: {message?: string} | null;
}

export interface NativeHostOptions {
    /**
     * Defaults to `browser`, then `chrome`. Supplying one is how this is tested, and how a caller
     * in a context with neither global can still use it.
     */
    runtime?: RuntimeLike;
    /** Milliseconds before an unanswered request is abandoned. Zero or absent waits indefinitely. */
    timeoutMs?: number;
    /**
     * What to send when a request is abandoned, given the id it was sent under.
     *
     * Abandoning a request stops this side listening; it does not stop the host working. Where the
     * host is doing something that costs -- a model asked a question, a file being read -- that is
     * a request paid for and thrown away, and the host is the only one who can stop it.
     *
     * The shape is the caller's because there is no cancellation in native messaging to conform
     * to: what a host understands is between the caller and its host. Absent, nothing is sent and
     * the host runs to completion, which is right for a host that cannot cancel and wrong for one
     * that can. Returning null for a particular id declines to cancel that one.
     *
     * The id is supplied because it is assigned here, so a caller cannot name the request without
     * being told. What comes back is posted as it is: it is not a request, it takes no id of its
     * own, and no reply is waited for.
     */
    cancelMessage?: (id: number) => object | null;
}

export interface NativeHost {
    /**
     * Sends `message` and resolves with the reply carrying the same `id`.
     *
     * Rejects if the host disconnects, if `timeoutMs` elapses, or if `signal` aborts. In every one
     * of those cases the reply, should it still arrive, is discarded rather than delivered late.
     *
     * Rejecting is this side giving up, not the host stopping. Where the host can be told, a
     * `cancelMessage` tells it; without one it finishes the work and answers into the void.
     */
    request<Response>(message: object, signal?: AbortSignal): Promise<Response>;
    /** Closes the port, which ends the host process. In-flight requests reject. */
    disconnect(): void;
}

export class NativeHostError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "NativeHostError";
    }
}

interface Pending {
    resolve(value: never): void;
    reject(error: Error): void;
    cleanUp(): void;
}

function defaultRuntime(): RuntimeLike {
    const globals = globalThis as unknown as Record<string, unknown>;
    const runtime = (globals.browser as {runtime?: RuntimeLike} | undefined)?.runtime
        ?? (globals.chrome as {runtime?: RuntimeLike} | undefined)?.runtime;

    if (!runtime)
        throw new NativeHostError("No extension runtime is available.");

    return runtime;
}

export function connectNativeHost(name: string, options: NativeHostOptions = {}): NativeHost {
    const {runtime = defaultRuntime(), timeoutMs = 0, cancelMessage} = options;

    const pending = new Map<number, Pending>();
    let port: PortLike | null = null;
    let nextId = 1;

    // A disconnect is not necessarily a failure of the request in flight -- the browser tears the
    // port down at page unload too -- but there is no reply coming either way, so everything
    // waiting is failed and the port dropped. The next request opens a new one, which is what makes
    // a crashed host recoverable rather than terminal for the page.
    function fail(reason: string) {
        const failed = [...pending.values()];
        pending.clear();

        const error = port?.error?.message ?? runtime.lastError?.message;
        port = null;

        for (const entry of failed) {
            entry.cleanUp();
            entry.reject(new NativeHostError(error ? `${reason}: ${error}` : reason));
        }
    }

    /**
     * Tells the host to stop working on a request nothing is waiting for any more.
     *
     * Only where there is still a port. A request abandoned because the port went away needs no
     * cancelling: the host is gone, which is a stronger cancellation than a message could be.
     */
    function abandon(id: number) {
        if (!port || !cancelMessage)
            return;

        const message = cancelMessage(id);
        if (!message)
            return;

        try {
            port.postMessage(message);
        } catch {
            // The port died between the abandonment and this, so the host has stopped anyway.
            // Failing the abandonment for it would replace the caller's reason for giving up --
            // an abort, a timeout -- with an incidental one.
        }
    }

    function ensurePort(): PortLike {
        if (port)
            return port;

        let opened: PortLike;
        try {
            opened = runtime.connectNative(name);
        } catch (cause) {
            throw new NativeHostError(`Connecting to the native application ${name} failed.`, {cause});
        }

        opened.onMessage.addListener(message => {
            // An id that matches nothing is a reply to a request already abandoned, or a host
            // sending unprompted. Neither has anywhere to go.
            const id = (message as {id?: unknown} | null)?.id;
            if (typeof id !== "number")
                return;

            const entry = pending.get(id);
            if (!entry)
                return;

            pending.delete(id);
            entry.cleanUp();
            entry.resolve(message as never);
        });

        opened.onDisconnect.addListener(() => fail("The native application disconnected."));

        port = opened;
        return opened;
    }

    return {
        request<Response>(message: object, signal?: AbortSignal): Promise<Response> {
            return new Promise<Response>((resolve, reject) => {
                if (signal?.aborted)
                    return void reject(new NativeHostError("The request was aborted before it was sent."));

                const id = nextId++;

                let timer: ReturnType<typeof setTimeout> | undefined;

                const onAbort = () => {
                    pending.delete(id);
                    cleanUp();
                    abandon(id);
                    reject(new NativeHostError("The request was aborted."));
                };

                function cleanUp() {
                    if (timer !== undefined)
                        clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                }

                if (timeoutMs > 0) {
                    timer = setTimeout(() => {
                        pending.delete(id);
                        cleanUp();
                        // A timeout abandons a request as thoroughly as an abort does. The host is
                        // still working on it, and after this nobody is waiting for the answer.
                        abandon(id);
                        reject(new NativeHostError(`The native application did not answer within ${timeoutMs} ms.`));
                    }, timeoutMs);
                    // Under node -- where these are tested -- a pending timer keeps the process
                    // alive on its own. In a browser `setTimeout` returns a number with no such
                    // method, hence the guard rather than a cast to node's `Timeout`.
                    (timer as unknown as {unref?: () => void}).unref?.();
                }

                signal?.addEventListener("abort", onAbort, {once: true});

                pending.set(id, {resolve: resolve as (value: never) => void, reject, cleanUp});

                try {
                    ensurePort().postMessage({...message, id});
                } catch (cause) {
                    pending.delete(id);
                    cleanUp();
                    reject(cause instanceof NativeHostError
                        ? cause
                        : new NativeHostError("Sending to the native application failed.", {cause}));
                }
            });
        },

        disconnect() {
            const open = port;
            fail("The port was closed.");
            open?.disconnect();
        },
    };
}
