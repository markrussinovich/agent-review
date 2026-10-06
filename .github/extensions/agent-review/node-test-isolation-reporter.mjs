export default async function* reporter(events) {
    for await (const event of events) {
        if (event.type === "test:pass" || event.type === "test:fail") {
            const { name, nesting, skip, todo, details } = event.data;
            yield `${JSON.stringify({ agent_review_test: true, name, nesting, skip: Boolean(skip),
                todo: Boolean(todo), outcome: event.type === "test:fail" ? "failed" : skip ? "skipped" : "passed",
                duration_ms: details?.duration_ms, error: details?.error?.message })}\n`;
        }
        if (event.type === "test:stderr" || event.type === "test:stdout") yield event.data.message;
    }
}
