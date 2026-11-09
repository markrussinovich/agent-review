export function describeAnalyzerError(error, { hasModel = false, initialization = false } = {}) {
    const csharp = /BadImageFormatException|C# analysis requires the prepared Roslyn helper|Could not load file or assembly[\s\S]*(AgentReview\.Dotnet|Microsoft\.CodeAnalysis)/i.test(error);
    return {
        title: csharp ? "The C# helper couldn't start on this machine."
            : initialization ? "Agent Review couldn't initialize this repository."
                : "Agent Review couldn't finish analysis.",
        action: csharp ? "Retry analysis. If it still fails, update Agent Review or rebuild the C# helper."
            : "Retry analysis. If it still fails, check the repository and comparison, then update Agent Review or report the problem with the technical details.",
        retained: hasModel ? "The previous saved review is still available; it does not include this failed analysis." : "",
        details: error,
    };
}

// Keep disclosure, selection and keyboard focus intact across background state updates.
export class AnalyzerErrorPresenter {
    constructor(container, { retry, copy }) {
        this.container = container;
        this.retry = retry;
        this.copy = copy;
        this.key = null;
    }

    render({ error, clientError, loading, unavailable, retrying, hasModel, initialization } = {}) {
        const key = JSON.stringify([error || null, error ? Boolean(hasModel) : clientError || null, Boolean(initialization)]);
        const container = this.container;
        container.classList.toggle("hidden", !error && !clientError);
        container.classList.toggle("analyzer-error", Boolean(error));
        if (this.key !== key) {
            this.key = key;
            container.replaceChildren();
            this.retryButton = null;
            this.recovery = null;
            if (error) {
                const message = describeAnalyzerError(error, { hasModel, initialization });
                const node = (tag, text, className = "") => {
                    const element = container.ownerDocument.createElement(tag);
                    element.textContent = text;
                    element.className = className;
                    return element;
                };
                container.append(node("strong", message.title), node("p", message.action));
                if (message.retained) container.append(node("p", message.retained, "muted"));
                this.retryButton = node("button", "Retry", "btn");
                this.retryButton.type = "button";
                this.retryButton.addEventListener("click", this.retry);
                const details = node("details", "", "analyzer-error-details");
                details.append(node("summary", "Technical details"));
                const copy = node("button", "Copy technical details", "btn");
                copy.type = "button";
                copy.setAttribute("aria-label", "Copy technical details");
                copy.addEventListener("click", () => {
                    this.copyError = null;
                    this.renderRecovery();
                    this.copy(copy, message.details, (failure) => {
                        copy.textContent = "Copy technical details";
                        copy.setAttribute("aria-label", "Copy technical details");
                        this.copyError = failure.message;
                        this.renderRecovery();
                    });
                });
                details.append(copy, node("pre", message.details));
                this.recovery = node("p", "", "analyzer-error-recovery hidden");
                this.recovery.setAttribute("role", "status");
                container.append(this.retryButton, details, this.recovery);
                this.copyError = null;
            } else if (clientError) container.textContent = clientError;
        }
        this.clientError = clientError && clientError !== error ? clientError : null;
        this.renderRecovery();
        if (this.retryButton) {
            this.retryButton.disabled = Boolean(loading || unavailable || retrying);
            this.retryButton.textContent = retrying ? "Retrying..." : "Retry";
        }
    }

    renderRecovery() {
        if (!this.recovery) return;
        this.recovery.textContent = [this.clientError, this.copyError].filter(Boolean).join("\n");
        this.recovery.classList.toggle("hidden", !this.recovery.textContent);
    }
}
