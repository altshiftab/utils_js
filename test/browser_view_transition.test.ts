import assert from "node:assert/strict";
import {afterEach, test} from "node:test";

import {updateWithViewTransition} from "../src/browser/view_transition.js";
import {installStubs, type Stubs} from "./browser_stubs.js";

let stubs: Stubs | null = null;

afterEach(() => {
    stubs?.restore();
    stubs = null;
});

test("the update runs inside a transition when one is available", async () => {
    stubs = installStubs({viewTransitions: true});

    let updated = false;
    await updateWithViewTransition(() => void (updated = true));

    assert.equal(updated, true);
    assert.equal(stubs.transitionCount, 1);
});

test("the update runs directly when the API is missing", async () => {
    stubs = installStubs({viewTransitions: false});

    let updated = false;
    await updateWithViewTransition(() => void (updated = true));

    assert.equal(updated, true);
    assert.equal(stubs.transitionCount, 0);
});

test("reduced motion skips the transition", async () => {
    stubs = installStubs({viewTransitions: true, reducedMotion: true});

    let updated = false;
    await updateWithViewTransition(() => void (updated = true));

    assert.equal(updated, true);
    assert.equal(stubs.transitionCount, 0);
});

test("an asynchronous update is awaited", async () => {
    stubs = installStubs({viewTransitions: true});

    let resolved = false;
    await updateWithViewTransition(async () => {
        await new Promise(resolve => setImmediate(resolve));
        resolved = true;
    });

    assert.equal(resolved, true);
});
