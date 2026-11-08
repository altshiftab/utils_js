// A headless-Chromium driver for the tests that need a real browser: what no DOM-less assertion can
// reach, such as shadow DOM, computed styles, a page's content security policy, or a built bundle
// loading at all. It is hand-rolled rather than taken as a dependency: Node supplies the WebSocket,
// so the Chrome DevTools Protocol needs no client library.
//
// It runs in Node, never in a page: it spawns the browser and serves files.

import {spawn, type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {createReadStream, existsSync} from "node:fs";
import {mkdtemp, rm} from "node:fs/promises";
import {createServer, type Server} from "node:http";
import {tmpdir} from "node:os";
import {delimiter, extname, join, normalize, resolve} from "node:path";

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

const BROWSER_NAMES = ["chromium", "google-chrome-stable", "google-chrome", "chrome"];

const DEFAULT_TIMEOUT_MS = 20_000;

// The browser binary. CHROME_PATH wins, so a machine without one of the usual names -- or CI
// pinning a specific build -- needs nothing here changed.
export function findBrowser(): string {
    const fromEnvironment = process.env.CHROME_PATH;
    if (fromEnvironment) {
        if (!existsSync(fromEnvironment))
            throw new Error(`CHROME_PATH is set to "${fromEnvironment}", which does not exist.`);
        return fromEnvironment;
    }

    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        if (!directory)
            continue;
        for (const name of BROWSER_NAMES) {
            const candidate = join(directory, name);
            if (existsSync(candidate))
                return candidate;
        }
    }

    throw new Error(
        `No Chromium found on PATH (looked for ${BROWSER_NAMES.join(", ")}). ` +
        "Install one or point CHROME_PATH at a binary."
    );
}

export interface Served {
    origin: string;
    close: () => Promise<void>;
}

export interface ServeOptions {
    // headers are sent with every file, as a content security policy a page is to be held to.
    headers?: Record<string, string>;
}

// Serves the files under the directory on a port of its own on the loopback interface, so a test page
// reaches what it imports by path. Nothing outside the directory is served.
export function serveDirectory(directory: string, options: ServeOptions = {}): Promise<Served> {
    const root = resolve(directory);
    const server: Server = createServer((request, response) => {
        const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
        const file = join(root, path);

        if (!file.startsWith(root + "/") || !existsSync(file)) {
            response.writeHead(404).end("not found");
            return;
        }

        response.writeHead(200, {
            "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
            ...options.headers,
        });
        createReadStream(file).pipe(response);
    });

    return new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
                reject(new Error("the test server did not bind a port"));
                return;
            }

            resolvePromise({
                origin: `http://127.0.0.1:${address.port}`,
                close: () => new Promise<void>(done => server.close(() => done())),
            });
        });
    });
}

export interface Cookie {
    name: string;
    value: string;
    // url is the address the cookie is set for, which gives it its domain and path.
    url: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
}

export interface OpenOptions {
    // cookies are set before the page is navigated to, as a session the page is served behind.
    cookies?: Cookie[];
    // ready is an expression the page is waited on until it is true, once it has loaded.
    ready?: string;
    timeoutMs?: number;
    // close is what else ends with the page, such as the server it was opened from.
    close?: () => Promise<void>;
}

type CdpMessage = {
    id?: number;
    method?: string;
    params?: any;
    result?: any;
    error?: {message: string};
};

// A page in a headless browser of its own: navigated to, evaluated in, and closed with it.
export class Page {
    // problems are what the page has reported going wrong, in order: uncaught exceptions, console
    // errors, and the browser's own errors about it, a content security policy's refusals among them.
    readonly problems: string[] = [];

    readonly #socket: WebSocket;
    readonly #pending = new Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>();
    readonly #listeners = new Map<string, Set<(params: any) => void>>();
    readonly #browser: ChildProcess;
    readonly #profile: string;
    readonly #closeAlso: (() => Promise<void>) | undefined;

    #sessionId = "";
    #nextId = 1;

    private constructor(socket: WebSocket, browser: ChildProcess, profile: string, closeAlso: (() => Promise<void>) | undefined) {
        this.#socket = socket;
        this.#browser = browser;
        this.#profile = profile;
        this.#closeAlso = closeAlso;
    }

    static async open(url: string, options: OpenOptions = {}): Promise<Page> {
        const profile = await mkdtemp(join(tmpdir(), "altshift-chromium-"));

        // Chromium refuses its own sandbox as root, which is the one case CI tends to hit.
        const sandbox = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
        const browser = spawn(findBrowser(), [
            "--headless",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            `--user-data-dir=${profile}`,
            "--remote-debugging-port=0",
            ...sandbox,
            "about:blank",
        ], {stdio: ["ignore", "ignore", "pipe"]});

        let page: Page | undefined;
        try {
            const endpoint = await readDevToolsEndpoint(browser);
            const socket = new WebSocket(endpoint);
            await once(socket, "open");

            page = new Page(socket, browser, profile, options.close);
            const opened = page;
            socket.addEventListener("message", event => opened.#receive(String(event.data)));

            // Target.* is addressed at the browser, so these two go out before a session exists; every
            // call after the attach carries the session id and lands in the page.
            const {targetId} = await page.#send("Target.createTarget", {url: "about:blank"});
            const {sessionId} = await page.#send("Target.attachToTarget", {targetId, flatten: true});
            page.#sessionId = sessionId;

            page.#on("Runtime.exceptionThrown", ({exceptionDetails}) => {
                opened.problems.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
            });
            page.#on("Runtime.consoleAPICalled", ({type, args}) => {
                if (type === "error" || type === "assert")
                    opened.problems.push(args.map((arg: any) => arg.value ?? arg.description ?? "").join(" "));
            });
            page.#on("Log.entryAdded", ({entry}) => {
                if (entry.level === "error")
                    opened.problems.push(`${entry.source}: ${entry.text}`);
            });

            await page.#send("Page.enable");
            await page.#send("Runtime.enable");
            await page.#send("Log.enable");
            await page.#send("Network.enable");
            for (const cookie of options.cookies ?? [])
                await page.#send("Network.setCookie", {...cookie});

            await page.goto(url, options);
            return page;
        } catch (error) {
            if (page !== undefined)
                await page.close();
            else {
                browser.kill();
                await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
                await options.close?.();
            }
            throw error;
        }
    }

    // Navigates to the address, and waits until the page has loaded and, if asked, is ready.
    async goto(url: string, options: {ready?: string, timeoutMs?: number} = {}): Promise<void> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const loaded = this.#next("Page.loadEventFired", timeoutMs);
        const {errorText} = await this.#send("Page.navigate", {url});
        if (errorText)
            throw new Error(`navigating to ${url}: ${errorText}`);
        await loaded;
        if (options.ready !== undefined)
            await this.waitFor(options.ready, timeoutMs);
    }

    // Waits until the expression is true in the page, polling it.
    async waitFor(expression: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        let last: unknown;
        for (;;) {
            try {
                if (await this.evaluate(expression) === true)
                    return;
            } catch (error) {
                // The document may not be the one waited for yet; keep polling until the deadline.
                last = error;
            }
            if (Date.now() > deadline)
                throw new Error(`waited ${timeoutMs} ms for ${expression}` + (last instanceof Error ? `: ${last.message}` : ""));
            await new Promise(done => setTimeout(done, 50));
        }
    }

    // Evaluates an expression in the page and returns its value, awaiting it if it is a promise.
    async evaluate<T = unknown>(expression: string): Promise<T> {
        const {result, exceptionDetails} = await this.#send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });

        if (exceptionDetails)
            throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);

        return result.value as T;
    }

    // Resizes the viewport, so a width-driven media query can be moved across its breakpoint while the
    // page is up rather than only chosen before it loads.
    async resize(width: number, height = 800): Promise<void> {
        await this.#send("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
        });
    }

    // Forces what `prefers-color-scheme` reports. The MediaQueryList the page captured at load stays
    // live, so a component listening for a change hears this one.
    async emulateColorScheme(scheme: "light" | "dark"): Promise<void> {
        await this.#send("Emulation.setEmulatedMedia", {
            features: [{name: "prefers-color-scheme", value: scheme}],
        });
    }

    async close(): Promise<void> {
        this.#socket.close();
        if (this.#browser.exitCode === null && this.#browser.signalCode === null) {
            const exited = once(this.#browser, "exit");
            this.#browser.kill();
            await exited;
        }
        // The browser's helper processes can still be writing to the profile as it exits.
        await rm(this.#profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
        await this.#closeAlso?.();
    }

    #receive(data: string) {
        const message: CdpMessage = JSON.parse(data);
        if (message.id === undefined) {
            if (message.method !== undefined)
                for (const listener of this.#listeners.get(message.method) ?? [])
                    listener(message.params);
            return;
        }

        const pending = this.#pending.get(message.id);
        if (pending === undefined)
            return;

        this.#pending.delete(message.id);
        if (message.error)
            pending.reject(new Error(message.error.message));
        else
            pending.resolve(message.result);
    }

    #on(method: string, listener: (params: any) => void) {
        let listeners = this.#listeners.get(method);
        if (listeners === undefined) {
            listeners = new Set();
            this.#listeners.set(method, listeners);
        }
        listeners.add(listener);
    }

    // The next event of the method, or an error once the time is up.
    #next(method: string, timeoutMs: number): Promise<any> {
        return new Promise((resolvePromise, reject) => {
            const listener = (params: any) => {
                clearTimeout(timer);
                this.#listeners.get(method)?.delete(listener);
                resolvePromise(params);
            };
            const timer = setTimeout(() => {
                this.#listeners.get(method)?.delete(listener);
                reject(new Error(`waited ${timeoutMs} ms for ${method}`));
            }, timeoutMs);
            this.#on(method, listener);
        });
    }

    #send(method: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = this.#nextId++;
        const payload: Record<string, unknown> = {id, method, params};
        if (this.#sessionId)
            payload.sessionId = this.#sessionId;

        return new Promise((resolvePromise, reject) => {
            this.#pending.set(id, {resolve: resolvePromise, reject});
            this.#socket.send(JSON.stringify(payload));
        });
    }
}

function readDevToolsEndpoint(browser: ChildProcess): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error("the browser never announced a DevTools endpoint")), DEFAULT_TIMEOUT_MS);
        let output = "";

        browser.stderr?.on("data", chunk => {
            output += String(chunk);
            const match = output.match(/ws:\/\/\S+/);
            if (match) {
                clearTimeout(timer);
                resolvePromise(match[0]);
            }
        });

        browser.once("exit", code => {
            clearTimeout(timer);
            reject(new Error(`the browser exited with code ${code} before listening:\n${output}`));
        });
    });
}
