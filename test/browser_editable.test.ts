import test from "node:test";
import assert from "node:assert/strict";

import {isEditable, isSensitive, readText, sensitivityReason} from "../src/browser/editable.js";

interface ElementOptions {
    attributes?: Record<string, string>;
    isContentEditable?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    value?: string;
    innerText?: string;
    textContent?: string;
    /** Whether an ancestor carries `aria-hidden="true"`, which is what `closest` is asked. */
    hiddenFromAssistiveTechnology?: boolean;
}

/**
 * A stand-in for an element, implementing only the surface `editable.ts` documents itself as
 * touching. Anything else is absent on purpose: a module that starts reading a new property fails
 * here rather than silently getting `undefined` and deciding a password field is prose.
 */
function element(tagName: string, options: ElementOptions = {}) {
    const {attributes = {}, hiddenFromAssistiveTechnology = false} = options;

    return {
        tagName,
        isContentEditable: options.isContentEditable,
        disabled: options.disabled,
        readOnly: options.readOnly,
        value: options.value,
        innerText: options.innerText,
        textContent: options.textContent ?? null,
        getAttribute: (name: string) => attributes[name] ?? null,
        hasAttribute: (name: string) => name in attributes,
        closest: (selectors: string) =>
            selectors === "[aria-hidden='true']" && hiddenFromAssistiveTechnology ? {} : null,
    } as unknown as Element;
}

test("fields that hold prose are readable", () => {
    const testCases = [
        {name: "a textarea", element: element("TEXTAREA")},
        {name: "a text input", element: element("INPUT", {attributes: {type: "text"}})},
        {name: "an input with no type defaults to text", element: element("INPUT")},
        {name: "a search input", element: element("INPUT", {attributes: {type: "search"}})},
        {name: "a contenteditable div", element: element("DIV", {isContentEditable: true})},
        {name: "a lowercase tag name", element: element("textarea")},
    ];

    for (const testCase of testCases)
        assert.equal(isEditable(testCase.element), true, testCase.name);
});

test("fields that do not hold prose are not readable", () => {
    const testCases = [
        {name: "a plain div", element: element("DIV")},
        {name: "a div with contenteditable false", element: element("DIV", {isContentEditable: false})},
        {name: "a disabled textarea", element: element("TEXTAREA", {disabled: true})},
        {name: "a read-only textarea", element: element("TEXTAREA", {readOnly: true})},
        {name: "a checkbox", element: element("INPUT", {attributes: {type: "checkbox"}})},
        {name: "a hidden input", element: element("INPUT", {attributes: {type: "hidden"}})},
        // Text, but never a sentence -- and an address is not something to hand to a model either.
        {name: "an email input", element: element("INPUT", {attributes: {type: "email"}})},
        {name: "a url input", element: element("INPUT", {attributes: {type: "url"}})},
        {name: "a telephone input", element: element("INPUT", {attributes: {type: "tel"}})},
    ];

    for (const testCase of testCases)
        assert.equal(isEditable(testCase.element), false, testCase.name);
});

// The cases that matter. Every one of these is a field whose contents must never leave the page,
// and each is excluded by a different rule, so a rule quietly removed shows up as one failure here
// rather than as nothing at all.
test("secrets are refused", () => {
    const testCases = [
        {name: "a password input", element: element("INPUT", {attributes: {type: "password"}})},
        {
            name: "autocomplete current-password on a text input",
            element: element("INPUT", {attributes: {type: "text", autocomplete: "current-password"}}),
        },
        {
            name: "autocomplete new-password",
            element: element("INPUT", {attributes: {type: "text", autocomplete: "new-password"}}),
        },
        {
            name: "autocomplete one-time-code",
            element: element("INPUT", {attributes: {type: "text", autocomplete: "one-time-code"}}),
        },
        {
            name: "a card number",
            element: element("INPUT", {attributes: {type: "text", autocomplete: "cc-number"}}),
        },
        {
            name: "a card security code",
            element: element("INPUT", {attributes: {type: "text", autocomplete: "cc-csc"}}),
        },
        {
            name: "autocomplete with several tokens",
            element: element("INPUT", {attributes: {type: "text", autocomplete: "section-blue shipping cc-exp"}}),
        },
        {
            name: "autocomplete in capitals",
            element: element("INPUT", {attributes: {type: "text", autocomplete: "One-Time-Code"}}),
        },
        {
            name: "a numeric keypad",
            element: element("INPUT", {attributes: {type: "text", inputmode: "numeric"}}),
        },
        {name: "a field named password", element: element("INPUT", {attributes: {type: "text", name: "password"}})},
        // Field names come in every casing there is, and a word boundary sees through none of
        // them: `\bpwd\b` does not match `user_pwd`, an underscore being a word character.
        {name: "snake case", element: element("INPUT", {attributes: {type: "text", name: "user_pwd"}})},
        {name: "kebab case", element: element("INPUT", {attributes: {type: "text", name: "user-pwd"}})},
        {name: "camel case", element: element("INPUT", {attributes: {type: "text", name: "userPwd"}})},
        {name: "camel case, long word", element: element("INPUT", {attributes: {type: "text", id: "loginPassword"}})},
        {name: "a field with id otp", element: element("INPUT", {attributes: {type: "text", id: "otp"}})},
        {name: "a field labelled CVV", element: element("INPUT", {attributes: {type: "text", "aria-label": "CVV"}})},
        {
            name: "a placeholder asking for a personnummer",
            element: element("INPUT", {attributes: {type: "text", placeholder: "Personnummer"}}),
        },
        {
            name: "a contenteditable named secret",
            element: element("DIV", {isContentEditable: true, attributes: {id: "api-secret"}}),
        },
        {
            name: "hidden from assistive technology",
            element: element("INPUT", {attributes: {type: "text"}, hiddenFromAssistiveTechnology: true}),
        },
    ];

    for (const testCase of testCases) {
        assert.equal(isSensitive(testCase.element), true, `${testCase.name}: sensitive`);
        assert.equal(isEditable(testCase.element), false, `${testCase.name}: not readable`);
    }
});

test("ordinary prose fields are not called sensitive", () => {
    const testCases = [
        {name: "a plain textarea", element: element("TEXTAREA")},
        {name: "a comment box", element: element("TEXTAREA", {attributes: {name: "comment"}})},
        {name: "a subject line", element: element("INPUT", {attributes: {type: "text", name: "subject"}})},
        {
            name: "autocomplete for a name",
            element: element("INPUT", {attributes: {type: "text", autocomplete: "given-name"}}),
        },
        {
            name: "spellcheck explicitly on",
            element: element("DIV", {isContentEditable: true, attributes: {spellcheck: "true"}}),
        },
        // The rule that used to refuse this one. Gmail's compose body sets spellcheck="false"
        // because it does its own checking, and refusing on it excluded the place a checker is
        // most wanted. Kept as a case so that the rule cannot come back by accident.
        {
            name: "a rich editor that turns the browser's own checking off",
            element: element("DIV", {isContentEditable: true, attributes: {spellcheck: "false"}}),
        },
        // The other side of the balance. Every one of these contains a short secret name as a
        // substring -- pin, pass, csc -- and refusing them would mean refusing ordinary prose.
        {name: "a shipping note", element: element("TEXTAREA", {attributes: {name: "shipping_note"}})},
        {name: "a passenger name", element: element("INPUT", {attributes: {type: "text", name: "passengerName"}})},
        {name: "a compass bearing", element: element("INPUT", {attributes: {type: "text", name: "compass"}})},
        {name: "a pinned message", element: element("TEXTAREA", {attributes: {id: "pinned-message"}})},
    ];

    for (const testCase of testCases)
        assert.equal(isSensitive(testCase.element), false, testCase.name);
});

test("readText takes the value from a control and the rendered text from a contenteditable", () => {
    const testCases = [
        {
            name: "an input's value",
            element: element("INPUT", {attributes: {type: "text"}, value: "hej"}),
            expected: "hej",
        },
        {
            name: "a textarea's value",
            element: element("TEXTAREA", {value: "två rader\nhär"}),
            expected: "två rader\nhär",
        },
        {
            name: "an empty input",
            element: element("INPUT", {attributes: {type: "text"}}),
            expected: "",
        },
        // innerText carries the line break the writer put there; textContent would not.
        {
            name: "a contenteditable's rendered text",
            element: element("DIV", {isContentEditable: true, innerText: "en rad\nen till", textContent: "en raden till"}),
            expected: "en rad\nen till",
        },
    ];

    for (const testCase of testCases)
        assert.equal(readText(testCase.element), testCase.expected, testCase.name);
});

// The reason exists so that a field skipped in the wild can be explained without reading the
// markup and guessing. Each rule is asserted to name itself, because a reason that says the wrong
// thing is worse than a boolean: it sends whoever is debugging to the wrong rule.
test("the refusing rule names itself", () => {
    const testCases = [
        {
            name: "input-type",
            element: element("INPUT", {attributes: {type: "password"}}),
            expected: "input-type",
        },
        {
            name: "autocomplete",
            element: element("INPUT", {attributes: {type: "text", autocomplete: "one-time-code"}}),
            expected: "autocomplete",
        },
        {
            name: "inputmode",
            element: element("INPUT", {attributes: {type: "text", inputmode: "numeric"}}),
            expected: "inputmode",
        },
        {
            name: "name",
            element: element("INPUT", {attributes: {type: "text", name: "user_pwd"}}),
            expected: "name",
        },
        {
            name: "aria-hidden",
            element: element("TEXTAREA", {hiddenFromAssistiveTechnology: true}),
            expected: "aria-hidden",
        },
        {
            name: "an ordinary field is refused by nothing",
            element: element("TEXTAREA", {attributes: {name: "comment"}}),
            expected: null,
        },
    ];

    for (const testCase of testCases) {
        assert.equal(sensitivityReason(testCase.element), testCase.expected, testCase.name);
        assert.equal(
            isSensitive(testCase.element),
            testCase.expected !== null,
            `${testCase.name}: isSensitive agrees with the reason`,
        );
    }
});

// The field this was all built for, in the shape it actually has. It was refused for a fortnight's
// worth of reasoning about what spellcheck="false" means, and the answer turned out to be "this
// editor does its own checking" rather than "this is not prose". Pinned as the markup rather than
// as the attribute, so that the case cannot be lost to a refactor that keeps the attribute test.
test("a Gmail-shaped compose body is checked", () => {
    const composeBody = element("DIV", {
        isContentEditable: true,
        attributes: {
            "aria-label": "Message Body",
            "role": "textbox",
            "aria-multiline": "true",
            "contenteditable": "true",
            "spellcheck": "false",
            "tabindex": "1",
            "g_editable": "true",
        },
        innerText: "Jag kan inte sluta tänkaaa på dig.",
    });

    assert.equal(sensitivityReason(composeBody), null, "nothing refuses it");
    assert.equal(isEditable(composeBody), true, "it is checked");
    assert.equal(readText(composeBody), "Jag kan inte sluta tänkaaa på dig.", "and read");
});

// Removing a rule must not have loosened the ones that matter. A secret in a rich editor that also
// turns spellchecking off is still a secret.
test("dropping the spellcheck rule did not weaken the real ones", () => {
    const testCases = [
        {
            name: "a password field that also sets spellcheck",
            element: element("INPUT", {attributes: {type: "password", spellcheck: "false"}}),
        },
        {
            name: "a one-time code that also sets spellcheck",
            element: element("INPUT", {attributes: {type: "text", autocomplete: "one-time-code", spellcheck: "false"}}),
        },
        {
            name: "a contenteditable named secret that also sets spellcheck",
            element: element("DIV", {isContentEditable: true, attributes: {id: "api-secret", spellcheck: "false"}}),
        },
    ];

    for (const testCase of testCases)
        assert.equal(isEditable(testCase.element), false, testCase.name);
});
