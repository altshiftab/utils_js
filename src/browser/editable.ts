/**
 * Which fields on a page hold prose a tool may read, and which it must leave alone.
 *
 * An extension that reads text fields across every site reads whatever is typed into them, and
 * some of what is typed into them is a password, a card number or a one-time code. The judgement
 * here is deliberately lopsided: excluding a field that would have been fine costs a missed
 * spell-check, and including one that was not costs a secret sent somewhere it should never go. So
 * every rule below resolves ambiguity by excluding, and a field is read only when it is positively
 * recognised as prose rather than when nothing objected to it.
 *
 * `spellcheck="false"` is deliberately not one of the rules, having been one and been wrong. The
 * reasoning was that an author setting it is declaring the contents are not prose -- code editors,
 * licence keys, identifier fields. What actually sets it is every rich text editor worth checking:
 * Gmail's compose body carries it, because Gmail does its own checking and does not want the
 * browser's underlines on top of its own. Excluding on it meant excluding the single place this is
 * most wanted, which was found by a field reporting the rule that refused it rather than by
 * reading the markup and guessing.
 *
 * The rule was politeness rather than protection, and nothing was lost with it: a password, a
 * one-time code and a card number are caught by their type, their autocomplete or their name, none
 * of which an editor sets by accident.
 *
 * The element surface touched here is small on purpose -- `tagName`, `getAttribute`,
 * `hasAttribute`, `closest`, `isContentEditable`, `value`, `innerText`, `disabled`, `readOnly` --
 * so that a test can supply a stand-in for it without a DOM implementation.
 */

/** Input types that hold prose. Everything else, `email`, `url` and `tel` included, does not. */
const proseInputTypes = new Set(["text", "search"]);

/**
 * Autocomplete tokens that name a secret outright. `cc-` is handled by prefix instead, since the
 * family is open-ended -- `cc-number`, `cc-csc`, `cc-exp-month` and whatever is added next.
 */
const secretAutocompleteTokens = new Set([
    "current-password",
    "new-password",
    "one-time-code",
]);

/**
 * Words that name a secret wherever they appear in an identifier. Long enough to be unambiguous,
 * so they are matched anywhere: `loginPassword`, `user-secret`, `kortnummer_cardnumber`.
 */
const secretWordPattern = /password|passphrase|passcode|secret|apikey|personnummer|socialsecurity|cardnumber|creditcard|securitycode/i;

/**
 * Short names for a secret, matched only when one is a whole word of the identifier.
 *
 * The distinction from the pattern above is what keeps this usable. As substrings these appear
 * inside perfectly ordinary words -- "pin" in shipping, "pass" in passenger and compass, "csc" in
 * any number of product codes -- and excluding every field whose name contains them would start
 * refusing prose. As words of an identifier they are what they look like.
 */
const secretTokens = new Set([
    "pwd", "pass", "pin", "otp", "totp", "mfa", "2fa", "cvv", "cvc", "ccv", "csc", "ssn", "token",
]);

/**
 * The words of an identifier, however it was written.
 *
 * Field names are snake_case, kebab-case and camelCase by turns, and a word boundary does not see
 * through any of them: `\b` treats an underscore as a word character, so `\bpwd\b` does not match
 * `user_pwd` -- which is exactly the shape a real password field's name takes. Splitting first and
 * comparing words is both more predictable and easier to be sure of.
 */
function identifierWords(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map(word => word.toLowerCase());
}

function namesASecret(value: string): boolean {
    if (secretWordPattern.test(value))
        return true;

    return identifierWords(value).some(word => secretTokens.has(word));
}

interface EditableLike {
    tagName: string;
    isContentEditable?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    value?: string;
    innerText?: string;
    textContent?: string | null;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    closest(selectors: string): unknown;
}

function asEditable(element: Element): EditableLike {
    return element as unknown as EditableLike;
}

function autocompleteTokens(element: EditableLike): string[] {
    return (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function inputType(element: EditableLike): string {
    // An `input` with no type is a text input, which is why the default matters: reading the
    // attribute rather than the property means an absent one has to be filled in here.
    return (element.getAttribute("type") ?? "text").toLowerCase();
}

/**
 * Whether the field is one a tool may read.
 *
 * True only for a text or search `input`, a `textarea`, or an element the browser reports as
 * `contenteditable` -- and in every case only when it is not sensitive, disabled or read-only.
 */
export function isEditable(element: Element): boolean {
    const candidate = asEditable(element);
    const tagName = candidate.tagName.toLowerCase();

    if (candidate.disabled || candidate.readOnly)
        return false;

    let editable: boolean;
    if (tagName === "input") {
        editable = proseInputTypes.has(inputType(candidate));
    } else if (tagName === "textarea") {
        editable = true;
    } else {
        editable = candidate.isContentEditable === true;
    }

    return editable && !isSensitive(element);
}

/** Why a field was refused. Named so that a caller can say which rule fired, not merely that one did. */
export type SensitivityReason =
    | "input-type"
    | "autocomplete"
    | "inputmode"
    | "name"
    | "aria-hidden";

/**
 * Whether the field must be left alone.
 *
 * Checked separately from `isEditable` so that a caller holding a field for another reason -- one
 * the user focused, one handed over by an event -- can ask the question directly.
 */
export function isSensitive(element: Element): boolean {
    return sensitivityReason(element) !== null;
}

/**
 * Which rule refused the field, or null if none did.
 *
 * The reason is returned rather than a boolean because "nothing happened" is the hardest state to
 * debug in a tool like this: a field that is silently skipped looks exactly like a field with
 * nothing wrong in it, and without the rule's name the only way to tell them apart is to reason
 * about the markup and guess. `isSensitive` is this with the answer thrown away.
 */
export function sensitivityReason(element: Element): SensitivityReason | null {
    const candidate = asEditable(element);
    const tagName = candidate.tagName.toLowerCase();

    if (tagName === "input" && !proseInputTypes.has(inputType(candidate)))
        return "input-type";

    const tokens = autocompleteTokens(candidate);
    if (tokens.some(token => secretAutocompleteTokens.has(token) || token.startsWith("cc-")))
        return "autocomplete";

    // A numeric or telephone keypad is not asked for to type sentences on.
    if (["numeric", "tel", "decimal"].includes((candidate.getAttribute("inputmode") ?? "").toLowerCase()))
        return "inputmode";

    for (const attribute of ["name", "id", "aria-label", "placeholder"]) {
        if (namesASecret(candidate.getAttribute(attribute) ?? ""))
            return "name";
    }

    // Hidden from assistive technology means hidden from this too: it is either not really a field
    // or it is a trap set for something that fills fields indiscriminately.
    return candidate.closest("[aria-hidden='true']") !== null ? "aria-hidden" : null;
}

/**
 * The text a field holds, as the person typing sees it.
 *
 * `innerText` rather than `textContent` for a contenteditable, because the two disagree exactly
 * where it matters: `textContent` runs the lines of a paragraph together without the breaks the
 * writer put there, and returns the contents of anything the page has hidden. It is the slower of
 * the two -- it forces layout -- which is a reason to call this on a settled field rather than on
 * every keystroke, not a reason to read the wrong string.
 */
export function readText(element: Element): string {
    const candidate = asEditable(element);
    const tagName = candidate.tagName.toLowerCase();

    if (tagName === "input" || tagName === "textarea")
        return candidate.value ?? "";

    return candidate.innerText ?? candidate.textContent ?? "";
}

/**
 * Every readable field under `root`, open shadow roots included.
 *
 * Shadow roots are descended into because a query that does not will miss most fields on a site
 * built from custom elements, and reporting nothing on such a site looks identical to working. A
 * closed root cannot be reached from here at all, and its fields are simply not found.
 */
export function findEditable(root: ParentNode): Element[] {
    const found: Element[] = [];

    const visit = (node: ParentNode) => {
        for (const element of node.querySelectorAll("input, textarea, [contenteditable]")) {
            if (isEditable(element))
                found.push(element);
        }

        // `querySelectorAll` does not cross a shadow boundary, so hosts are walked for their roots
        // separately -- and every element is a potential host, not only the ones matched above.
        for (const element of node.querySelectorAll("*")) {
            const shadowRoot = element.shadowRoot;
            if (shadowRoot)
                visit(shadowRoot);
        }
    };

    visit(root);

    return found;
}
