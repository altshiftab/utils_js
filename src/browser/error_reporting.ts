/**
 * Reporting of uncaught errors and unhandled promise rejections to a collecting endpoint.
 */

export interface ErrorDetails {
    message?: string;
    cause?: unknown;
    stack?: string;
    name?: string;
    code?: number;
}

export interface BaseErrorBody {
    type: string
    raw?: string
    error?: ErrorDetails;
}

export interface ErrorBody extends BaseErrorBody {
    colno: number;
    filename: string;
    lineno: number;
    message: string;
    type: string;
}

export interface ErrorReportingOptions {
    errorPath?: string;
    unhandledRejectionPath?: string;
}

const defaultErrorPath = "/api/report/error";
const defaultUnhandledRejectionPath = "/api/report/unhandled-rejection";

function getRaw(error: Error): string | undefined {
    let rawError: string | undefined = undefined;
    try {
        rawError = JSON.stringify(error);
        if (rawError === "{}") {
            rawError = undefined;
        }
    } catch {}

    return rawError;
}

function getBaseBody(error: (Error & {code?: number}) | null | undefined): BaseErrorBody {
    // A cross-origin script error, and a rejection with no reason, carry no error object.
    if (!error)
        return {type: typeof error};

    return {
        error: {
            cause: error.cause,
            stack: error.stack,
            name: error.name,
            message: error.message,
            code: error?.code
        },
        type: error?.constructor?.name ?? typeof error,
        raw: getRaw(error),
    };
}

function postError(path: string, body: BaseErrorBody | ErrorBody) {
    return fetch(
        path,
        {
            method: "POST",
            body: JSON.stringify(body),
            headers: {"Content-Type": "application/json"},
            keepalive: true,
        }
    );
}

export function addErrorEventListeners(options: ErrorReportingOptions = {}) {
    const {
        errorPath = defaultErrorPath,
        unhandledRejectionPath = defaultUnhandledRejectionPath,
    } = options;

    addEventListener("error", event => {
        const {message, filename, lineno, colno, error} = event;
        const body = {
            colno,
            filename,
            lineno,
            message,
            ...getBaseBody(error)
        };

        postError(errorPath, body).catch(err => {
            // TODO: Make this nicer.
            console.error("An error occurred when reporting an error: ", err);
        });
    });

    addEventListener("unhandledrejection", event => {
        postError(unhandledRejectionPath, getBaseBody(event.reason)).catch(err => {
            // TODO: Make this nicer.
            console.error("An error occurred when reporting an unhandled rejection: ", err);
        });
    });
}
