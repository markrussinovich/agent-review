import { posix } from "node:path";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decode(segment) {
    const values = [];
    let value = 0;
    let shift = 0;
    for (const character of segment) {
        const digit = alphabet.indexOf(character);
        if (digit < 0) throw new Error("Invalid source-map VLQ character.");
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) shift += 5;
        else {
            values.push(value % 2 ? -Math.floor(value / 2) : Math.floor(value / 2));
            value = 0;
            shift = 0;
        }
    }
    if (shift) throw new Error("Incomplete source-map VLQ segment.");
    return values;
}

export function sourceMapLines(map, mapPath) {
    if (map?.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== "string") {
        throw new Error("Only standard version-3 source maps with explicit mappings are supported.");
    }
    const sources = map.sources.map((source) => {
        const combined = `${map.sourceRoot || ""}${map.sourceRoot && !map.sourceRoot.endsWith("/") ? "/" : ""}${source}`;
        if (/^webpack:\/\/\//.test(combined)) return posix.normalize(combined.replace(/^webpack:\/\/\/(?:\.\/)?/, ""));
        if (/^(?:\/|[A-Za-z]:[\\/]|file:)/.test(combined)) return combined;
        return posix.normalize(posix.join(posix.dirname(mapPath), combined));
    });
    const result = new Map();
    let source = 0;
    let line = 0;
    let column = 0;
    for (const [generated, segments] of map.mappings.split(";").entries()) {
        const targets = new Set();
        for (const segment of segments.split(",").filter(Boolean)) {
            const fields = decode(segment);
            if (fields.length === 1) continue;
            if (fields.length !== 4 && fields.length !== 5) throw new Error("Invalid source-map segment arity.");
            source += fields[1];
            line += fields[2];
            column += fields[3];
            if (!sources[source] || line < 0 || column < 0) throw new Error("Source-map coordinates are out of bounds.");
            targets.add(JSON.stringify([sources[source], line + 1, source]));
        }
        // Ambiguous generated lines cannot prove an individual original line.
        if (targets.size === 1) result.set(generated + 1, JSON.parse([...targets][0]));
    }
    return result;
}
