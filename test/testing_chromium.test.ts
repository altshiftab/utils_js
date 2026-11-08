import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, test} from "node:test";

import {Page, serveDirectory, type Served} from "../src/testing/chromium.js";

// The pages are written for the test into a directory of their own, served under a content security
// policy that refuses inline styles, as a page held to one would be.
const policy = "default-src 'self'";

let directory: string;
let served: Served;
let page: Page;

before(async () => {
    // The site is a directory beside a file it must not serve, so that a path out of it has something
    // to reach for.
    directory = await mkdtemp(join(tmpdir(), "chromium-test-"));
    const site = join(directory, "site");
    await mkdir(site);
    await writeFile(join(site, "index.html"), `<!doctype html>
<title>test</title>
<div id="styled" style="color: red">styled</div>
<script type="module" src="/app.js"></script>`);
    await writeFile(join(site, "app.js"), `
console.error("logged by the page");
// Ready only some time after loading, so that being waited for is something to be told apart.
addEventListener("load", () => setTimeout(() => { window.ready = true; }, 200));
setTimeout(() => { throw new Error("thrown by the page"); });`);
    await writeFile(join(directory, "secret.txt"), "not to be served from the site");
    served = await serveDirectory(site, {headers: {"content-security-policy": policy}});
    page = await Page.open(`${served.origin}/index.html`, {ready: "window.ready === true"});
}, {timeout: 60_000});

after(async () => {
    await page?.close();
    await served?.close();
    await rm(directory, {recursive: true, force: true});
});

// eventually waits until the condition holds of what has been reported, as the browser reports it
// when it gets to it.
async function eventually(condition: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline)
            return;
        await new Promise(done => setTimeout(done, 50));
    }
}

test("an expression is evaluated in the page, and its value returned", async () => {
    const testCases = [
        {name: "arithmetic", expression: "1 + 1", expected: 2},
        {name: "the document", expression: "document.getElementById('styled').textContent", expected: "styled"},
        {name: "a promise, awaited", expression: "Promise.resolve('resolved')", expected: "resolved"},
        {name: "an object, by value", expression: "({a: [1, 2]})", expected: {a: [1, 2]}},
    ];
    for (const testCase of testCases)
        assert.deepEqual(await page.evaluate(testCase.expression), testCase.expected, testCase.name);

    await assert.rejects(page.evaluate("missing.property"), /missing is not defined/, "an exception is thrown");
});

test("what the page reports going wrong is kept", async () => {
    const testCases = [
        {name: "a console error", pattern: /logged by the page/},
        {name: "an uncaught exception", pattern: /thrown by the page/},
        {name: "the content security policy's refusal", pattern: /Content Security Policy/},
    ];
    await eventually(() => testCases.every(testCase => page.problems.some(problem => testCase.pattern.test(problem))));
    for (const testCase of testCases)
        assert.ok(page.problems.some(problem => testCase.pattern.test(problem)), `${testCase.name}: ${JSON.stringify(page.problems)}`);
});

test("goto loads the page anew, and waitFor gives up at its deadline", async () => {
    await page.evaluate("window.marker = 1");
    await page.goto(`${served.origin}/index.html`, {ready: "window.ready === true"});
    assert.equal(await page.evaluate("window.marker"), undefined, "a page loaded anew");
    assert.equal(await page.evaluate("window.ready"), true, "ready, waited for");

    await assert.rejects(page.waitFor("false", 200), /waited 200 ms for false/, "the deadline");
});

test("the viewport and the colour scheme are the test's to set", async () => {
    await page.resize(500, 700);
    assert.deepEqual(await page.evaluate("[innerWidth, innerHeight]"), [500, 700], "the viewport");

    for (const scheme of ["dark", "light"] as const) {
        await page.emulateColorScheme(scheme);
        assert.equal(await page.evaluate(`matchMedia("(prefers-color-scheme: ${scheme})").matches`), true, scheme);
    }
});

test("the files served are the directory's, with the headers asked for", async () => {
    const testCases = [
        {name: "a page", path: "/index.html", status: 200},
        {name: "a file missing", path: "/missing.html", status: 404},
        // An encoded slash, so that the path reaches the server as it is rather than resolved by the client.
        {name: "a path out of the directory", path: "/..%2fsecret.txt", status: 404},
    ];
    for (const testCase of testCases) {
        const response = await fetch(`${served.origin}${testCase.path}`);
        await response.arrayBuffer();
        assert.equal(response.status, testCase.status, testCase.name);
    }
    const response = await fetch(`${served.origin}/index.html`);
    await response.arrayBuffer();
    assert.equal(response.headers.get("content-security-policy"), policy, "the header");
});

test("cookies are set before the page is opened, and what closes with the page is closed", async () => {
    const own = await serveDirectory(join(directory, "site"));
    let closed = false;
    const withCookie = await Page.open(`${own.origin}/index.html`, {
        cookies: [{name: "session", value: "s1", url: own.origin}],
        ready: "window.ready === true",
        close: async () => {
            closed = true;
            await own.close();
        },
    });
    try {
        assert.equal(await withCookie.evaluate("document.cookie"), "session=s1", "the cookie");
    } finally {
        await withCookie.close();
    }
    assert.equal(closed, true, "closed with the page");
    await assert.rejects(fetch(`${own.origin}/index.html`), "the server is gone");
});
