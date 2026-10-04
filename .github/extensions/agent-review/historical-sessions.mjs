import { CopilotClient } from "@github/copilot-sdk";

import { buildSessionContext } from "./session-context.mjs";

function isUsefulSession(metadata, currentSessionId) {
    if (!metadata?.sessionId || metadata.sessionId === currentSessionId) return false;
    const directory = String(metadata.context?.workingDirectory || "").replaceAll("\\", "/").toLowerCase();
    if (directory.endsWith("/canvas-catalog-probe")) return false;
    return true;
}

export async function loadHistoricalSessionContexts(repoRoot, currentSessionId, options = {}) {
    const limit = Number.isInteger(options.limit) ? options.limit : 6;
    const client = new CopilotClient();
    const contexts = [];
    const failures = [];
    try {
        await client.start();
        const sessions = (await client.listSessions())
            .filter((metadata) => isUsefulSession(metadata, currentSessionId))
            .sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime())
            .slice(0, limit);
        for (const metadata of sessions) {
            let historical;
            try {
                historical = await client.resumeSession(metadata.sessionId, {});
                const context = buildSessionContext(await historical.getEvents(), repoRoot);
                context.session_id = metadata.sessionId;
                context.session_summary = metadata.summary || "Untitled session";
                context.working_directory = metadata.context?.workingDirectory || null;
                for (const turn of context.turns) {
                    turn.session_id = metadata.sessionId;
                    turn.session_summary = context.session_summary;
                }
                contexts.push(context);
            } catch (error) {
                failures.push({ session_id: metadata.sessionId, error: error.message });
            } finally {
                if (historical) await historical.disconnect();
            }
        }
    } finally {
        await client.stop();
    }
    return { contexts, failures };
}
