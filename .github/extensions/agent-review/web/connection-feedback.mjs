export class ConnectionFeedback {
    constructor({ onChange, graceMs = 3000,
        setTimer = (callback, delay) => setTimeout(callback, delay),
        clearTimer = (timer) => clearTimeout(timer) }) {
        this.onChange = onChange;
        this.graceMs = graceMs;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.phase = "connecting";
        this.hasConnected = false;
        this.timer = null;
    }

    failed() {
        if (this.phase === "lost") return;
        this.phase = this.hasConnected ? "reconnecting" : "connecting";
        if (this.timer === null) {
            this.timer = this.setTimer(() => {
                this.timer = null;
                this.phase = "lost";
                this.onChange(this.phase);
            }, this.graceMs);
        }
        this.onChange(this.phase);
    }

    connected() {
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = null;
        this.hasConnected = true;
        this.phase = "connected";
        this.onChange(this.phase);
    }
}
