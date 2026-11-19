import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function renameWithRetry(source, destination) {
    const deadline = Date.now() + 500;
    while (true) {
        try {
            await rename(source, destination);
            return;
        } catch (error) {
            if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code)
                || Date.now() >= deadline) throw error;
            await delay(25);
        }
    }
}
