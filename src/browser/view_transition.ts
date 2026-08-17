export async function updateWithViewTransition(update: () => unknown) {
    if (!("startViewTransition" in document) || matchMedia("(prefers-reduced-motion: reduce)").matches)
        return void await update();

    await document.startViewTransition(async () => void await update()).updateCallbackDone;
}
