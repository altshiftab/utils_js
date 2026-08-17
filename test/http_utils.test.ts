import assert from "node:assert/strict";
import {afterEach, test} from "node:test";

import {BadStatusCodeError, FetchError} from "../src/http/errors.js";
import {fetchEx, getBadStatusCodeErrorMessage, problemDetailFromResponseText} from "../src/http/utils.js";

type Respond = (request: Request) => Response | Promise<Response>;

let restore: (() => void) | null = null;

afterEach(() => {
    restore?.();
    restore = null;
});

function installFetch(respond: Respond) {
    const calls: Request[] = [];
    const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");

    (globalThis as unknown as Record<string, unknown>).fetch = (request: Request) => {
        calls.push(request);
        return Promise.resolve(respond(request));
    };

    restore = () => {
        if (saved) {
            Object.defineProperty(globalThis, "fetch", saved);
        } else {
            delete (globalThis as unknown as Record<string, unknown>).fetch;
        }
    };

    return calls;
}

test("a successful response is returned with its body", async () => {
    const calls = installFetch(() => new Response("hello", {status: 200}));

    const {response, responseText} = await fetchEx("https://example.test/thing");

    assert.equal(response.status, 200);
    assert.equal(responseText, "hello");
    assert.equal(calls[0]!.method, "GET");
});

test("a bad status code throws with the body captured in the context", async () => {
    installFetch(() => new Response("nope", {status: 503}));

    await assert.rejects(fetchEx("https://example.test/thing"), (error: unknown) => {
        assert.ok(error instanceof BadStatusCodeError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.context.responseBody, "nope");
        return true;
    });
});

test("skipErrorOnStatusCode is forwarded", async () => {
    // Regression: fetchEx accepted RequestInitEx but dropped it, so this threw.
    installFetch(() => new Response("nope", {status: 503}));

    const {response} = await fetchEx("https://example.test/thing", {skipErrorOnStatusCode: true});

    assert.equal(response.status, 503);
});

test("skipReadResponseBody is forwarded", async () => {
    const response = new Response("unread", {status: 200});
    installFetch(() => response);

    const result = await fetchEx("https://example.test/thing", {skipReadResponseBody: true});

    assert.equal(result.responseText, "");
    assert.equal(response.bodyUsed, false);
});

test("both flags together leave a failing response to the caller", async () => {
    const response = new Response("unread", {status: 401});
    installFetch(() => response);

    const result = await fetchEx(new URL("https://example.test/thing"), {
        method: "POST",
        skipReadResponseBody: true,
        skipErrorOnStatusCode: true,
    });

    assert.equal(result.response.status, 401);
    assert.equal(response.bodyUsed, false);
});

test("a transport failure becomes a FetchError", async () => {
    installFetch(() => {throw new TypeError("offline");});

    await assert.rejects(fetchEx("https://example.test/thing"), (error: unknown) => {
        assert.ok(error instanceof FetchError);
        assert.ok(error.cause instanceof TypeError);
        return true;
    });
});

test("problem details are recognised only when title and status are present", () => {
    const testCases = [
        {name: "complete", text: '{"title":"Nope","status":403,"detail":"Not allowed"}', expected: true},
        {name: "missing status", text: '{"title":"Nope"}', expected: false},
        {name: "missing title", text: '{"status":403}', expected: false},
        {name: "not json", text: "plain text", expected: false},
        {name: "empty", text: "", expected: false},
    ];

    for (const testCase of testCases)
        assert.equal(problemDetailFromResponseText(testCase.text) !== null, testCase.expected, testCase.name);
});

test("the bad status code message prefers the problem detail", async () => {
    installFetch(() => new Response('{"title":"Nope","status":403,"detail":"Not allowed"}', {status: 403}));

    const error = await fetchEx("https://example.test/thing").catch((error: unknown) => error);
    assert.ok(error instanceof BadStatusCodeError);
    assert.equal(getBadStatusCodeErrorMessage(error), "Not allowed");
});

test("the bad status code message falls back to the raw body, then the error itself", async () => {
    installFetch(() => new Response("something went wrong", {status: 500}));

    const withBody = await fetchEx("https://example.test/thing").catch((error: unknown) => error);
    assert.ok(withBody instanceof BadStatusCodeError);
    assert.equal(getBadStatusCodeErrorMessage(withBody), "something went wrong");

    restore?.();
    installFetch(() => new Response(null, {status: 500}));

    const withoutBody = await fetchEx("https://example.test/thing").catch((error: unknown) => error);
    assert.ok(withoutBody instanceof BadStatusCodeError);
    assert.match(getBadStatusCodeErrorMessage(withoutBody), /bad status code/);
});
