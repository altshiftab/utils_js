import test from "node:test";
import assert from "node:assert/strict";

import {connectNativeHost, NativeHostError} from "../src/browser/native_messaging.js";
import type {PortLike, RuntimeLike} from "../src/browser/native_messaging.js";

/**
 * A stand-in for a native messaging port that behaves like one: messages sent are recorded, and
 * replies are delivered only when the test says so, since a real host answers whenever it answers
 * rather than in the call. A port that resolved inside `postMessage` would let a module that never
 * correlated replies pass every test here.
 */
class PortStub implements PortLike {
    sent: any[] = [];
    disconnected = false;
    error: {message?: string} | null = null;

    #messageListeners: ((message: unknown) => void)[] = [];
    #disconnectListeners: (() => void)[] = [];

    onMessage = {addListener: (listener: (message: unknown) => void) => void this.#messageListeners.push(listener)};
    onDisconnect = {addListener: (listener: () => void) => void this.#disconnectListeners.push(listener)};

    postMessage(message: unknown) {
        if (this.disconnected)
            throw new Error("posting to a disconnected port");
        this.sent.push(message);
    }

    disconnect() {
        this.disconnected = true;
    }

    /** What the host sending a message looks like from the extension's side. */
    deliver(message: unknown) {
        for (const listener of this.#messageListeners)
            listener(message);
    }

    /** What the host dying, or the browser tearing the port down, looks like. */
    dropped() {
        this.disconnected = true;
        for (const listener of this.#disconnectListeners)
            listener();
    }
}

class RuntimeStub implements RuntimeLike {
    ports: PortStub[] = [];
    lastError: {message?: string} | null = null;
    connectCount = 0;

    connectNative(_name: string): PortLike {
        this.connectCount++;
        const port = new PortStub();
        this.ports.push(port);
        return port;
    }

    get port(): PortStub {
        return this.ports[this.ports.length - 1];
    }
}

test("a reply resolves the request it answers", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime});

    const pending = host.request<{id: number; text: string}>({type: "correct", text: "teh"});

    const sent = runtime.port.sent[0];
    assert.equal(sent.type, "correct", "the message reached the port");
    assert.equal(typeof sent.id, "number", "the request carries an id");

    runtime.port.deliver({id: sent.id, text: "the"});

    assert.equal((await pending).text, "the");
});

// The reason this module exists. A host answering a short request before a long one that was asked
// first is ordinary, and without correlation the first waiter takes the second's answer.
test("replies are matched to requests, not to arrival order", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime});

    const first = host.request<{value: string}>({type: "slow"});
    const second = host.request<{value: string}>({type: "fast"});

    const [firstId, secondId] = runtime.port.sent.map(message => message.id);
    assert.notEqual(firstId, secondId, "each request gets its own id");

    runtime.port.deliver({id: secondId, value: "second"});
    runtime.port.deliver({id: firstId, value: "first"});

    assert.equal((await first).value, "first");
    assert.equal((await second).value, "second");
});

test("a reply with no matching id is discarded", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime});

    const pending = host.request<{value: string}>({type: "correct"});
    const id = runtime.port.sent[0].id;

    runtime.port.deliver({id: id + 1000, value: "not yours"});
    runtime.port.deliver({value: "no id at all"});
    runtime.port.deliver(null);

    runtime.port.deliver({id, value: "yours"});

    assert.equal((await pending).value, "yours");
});

test("the port is opened once and reused", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime});

    const first = host.request<{id: number}>({type: "a"});
    const second = host.request<{id: number}>({type: "b"});

    runtime.port.deliver({id: runtime.port.sent[0].id});
    runtime.port.deliver({id: runtime.port.sent[1].id});
    await Promise.all([first, second]);

    assert.equal(runtime.connectCount, 1, "one process, not one per request");
});

test("a disconnect rejects everything in flight", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime});

    const first = host.request({type: "a"});
    const second = host.request({type: "b"});

    runtime.port.error = {message: "no such native application"};
    runtime.port.dropped();

    for (const pending of [first, second]) {
        await assert.rejects(pending, (error: Error) => {
            assert.ok(error instanceof NativeHostError);
            assert.match(error.message, /disconnected/);
            assert.match(error.message, /no such native application/, "the port's reason is carried through");
            return true;
        });
    }
});

// A crashed host must not make the page useless: the next request opens a new process.
test("a request after a disconnect opens a new port", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime});

    await assert.rejects(
        (() => {
            const pending = host.request({type: "a"});
            runtime.port.dropped();
            return pending;
        })(),
    );

    const pending = host.request<{value: string}>({type: "b"});
    assert.equal(runtime.connectCount, 2, "a second process was started");

    runtime.port.deliver({id: runtime.port.sent[0].id, value: "recovered"});
    assert.equal((await pending).value, "recovered");
});

test("aborting rejects the request and discards a late reply", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime});

    const controller = new AbortController();
    const pending = host.request({type: "correct"}, controller.signal);
    const id = runtime.port.sent[0].id;

    controller.abort();

    await assert.rejects(pending, (error: Error) => {
        assert.ok(error instanceof NativeHostError);
        assert.match(error.message, /aborted/);
        return true;
    });

    // Arriving after the abort must do nothing at all rather than resolve an abandoned promise.
    assert.doesNotThrow(() => runtime.port.deliver({id, value: "too late"}));
});

test("a signal already aborted is refused without sending", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime});

    await assert.rejects(host.request({type: "correct"}, AbortSignal.abort()));

    assert.equal(runtime.connectCount, 0, "nothing was sent, so no process was started");
});

test("an unanswered request times out", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime, timeoutMs: 10});

    await assert.rejects(host.request({type: "correct"}), (error: Error) => {
        assert.ok(error instanceof NativeHostError);
        assert.match(error.message, /within 10 ms/);
        return true;
    });
});

test("a reply that arrives before the timeout wins", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime, timeoutMs: 1_000});

    const pending = host.request<{value: string}>({type: "correct"});
    runtime.port.deliver({id: runtime.port.sent[0].id, value: "in time"});

    assert.equal((await pending).value, "in time");
});

test("disconnecting closes the port and rejects what was waiting", async () => {
    const runtime = new RuntimeStub();
    const host = connectNativeHost("proofread", {runtime});

    const pending = host.request({type: "correct"});
    const port = runtime.port;

    host.disconnect();

    await assert.rejects(pending, /closed/);
    assert.ok(port.disconnected, "the underlying port was closed");
});

test("a runtime that cannot connect surfaces as a NativeHostError", async () => {
    const runtime: RuntimeLike = {
        connectNative() {
            throw new Error("Attempt to postMessage on disconnected port");
        },
    };

    await assert.rejects(connectNativeHost("proofread", {runtime}).request({type: "a"}), (error: Error) => {
        assert.ok(error instanceof NativeHostError);
        assert.match(error.message, /proofread/);
        return true;
    });
});
