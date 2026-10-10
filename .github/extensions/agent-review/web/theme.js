(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const requested = new URLSearchParams(window.location.search).get("scoutTheme");
    const validMode = (value) => ["light", "dark"].includes(value) ? value : null;
    const override = validMode(requested);
    if (requested && !override) console.warn("[agent-review] Unsupported scoutTheme; expected light or dark.");

    const synchronize = () => {
        const host = validMode(root.getAttribute("data-color-mode"))
            || validMode(document.body?.getAttribute("data-color-mode"));
        root.setAttribute("data-theme", override || host || (media.matches ? "dark" : "light"));
        root.setAttribute("data-agent-review-theme", override ? "override" : host ? "host" : "system");
    };
    const observer = new MutationObserver(synchronize);
    const options = { attributes: true, attributeFilter: ["data-color-mode"] };
    observer.observe(root, options);
    const observeBody = () => {
        observer.observe(document.body, options);
        synchronize();
    };
    if (document.body) observeBody();
    else document.addEventListener("DOMContentLoaded", observeBody, { once: true });
    media.addEventListener("change", synchronize);
    synchronize();
})();
