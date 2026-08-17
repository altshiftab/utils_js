import assert from "node:assert/strict";
import {afterEach, test} from "node:test";

import {addErrorEventListeners} from "../src/browser/error_reporting.js";
import {installStubs, readBody, type Stubs} from "./browser_stubs.js";

let stubs: Stubs | null = null;

afterEach(() => {
    stubs?.restore();
    stubs = null;
});

function errorEvent(error: unknown) {
    return {message: "boom", filename: "https://example.test/a.js", lineno: 12, colno: 34, error};
}

test("error event is reported", async () => {
    stubs = installStubs();
    addErrorEventListeners();

    const error = Object.assign(new TypeError("boom"), {code: 7, cause: "underlying"});
    await stubs.dispatch("error", errorEvent(error));

    assert.equal(stubs.fetchCalls.length, 1);

    const call = stubs.fetchCalls[0]!;
    assert.equal(call.input, "/api/report/error");
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.keepalive, true);

    assert.deepEqual(readBody(call), {
        colno: 34,
        filename: "https://example.test/a.js",
        lineno: 12,
        message: "boom",
        type: "TypeError",
        error: {cause: "underlying", stack: error.stack, name: "TypeError", message: "boom", code: 7},
        // Own enumerable properties an Error does not otherwise expose are carried through as `raw`.
        raw: '{"code":7,"cause":"underlying"}',
    });
});

test("an error with nothing to serialise carries no raw field", async () => {
    stubs = installStubs();
    addErrorEventListeners();

    await stubs.dispatch("error", errorEvent(new Error("boom")));

    assert.equal(readBody(stubs.fetchCalls[0]!).raw, undefined);
});

test("unhandled rejection is reported", async () => {
    stubs = installStubs();
    addErrorEventListeners();

    await stubs.dispatch("unhandledrejection", {reason: new RangeError("nope")});

    assert.equal(stubs.fetchCalls.length, 1);

    const call = stubs.fetchCalls[0]!;
    assert.equal(call.input, "/api/report/unhandled-rejection");
    assert.equal(readBody(call).type, "RangeError");
    assert.equal(readBody(call).error.message, "nope");
});

test("report paths are configurable", async () => {
    stubs = installStubs();
    addErrorEventListeners({errorPath: "/report/e", unhandledRejectionPath: "/report/r"});

    await stubs.dispatch("error", errorEvent(new Error("boom")));
    await stubs.dispatch("unhandledrejection", {reason: new Error("nope")});

    assert.deepEqual(stubs.fetchCalls.map(call => call.input), ["/report/e", "/report/r"]);
});

test("a missing error object is reported rather than throwing", async () => {
    // A cross-origin script error arrives with `error` null.
    const testCases = [
        {name: "null error event", type: "error" as const, event: errorEvent(null)},
        {name: "undefined error event", type: "error" as const, event: errorEvent(undefined)},
        {name: "rejection without reason", type: "unhandledrejection" as const, event: {reason: undefined}},
    ];

    for (const testCase of testCases) {
        stubs = installStubs();
        addErrorEventListeners();

        await stubs.dispatch(testCase.type, testCase.event);

        assert.equal(stubs.fetchCalls.length, 1, testCase.name);
        assert.equal(readBody(stubs.fetchCalls[0]!).error, undefined, testCase.name);

        stubs.restore();
        stubs = null;
    }
});

test("a failing report does not reject", async () => {
    stubs = installStubs({respond: () => Promise.reject(new Error("offline")) as unknown as Response});
    addErrorEventListeners();

    // The listener swallows the failure; an escaping rejection would fail this test.
    await stubs.dispatch("error", errorEvent(new Error("boom")));
    await new Promise(resolve => setImmediate(resolve));
});
