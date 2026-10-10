const SVG_NS = "http://www.w3.org/2000/svg";
const savedPositions = new Map();
const graphResizers = new WeakMap();

function svg(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
}

function displayName(node) {
    return node.display_name || node.name || node.qualified_name || node.id;
}

function wrapLabel(value, max = 24) {
    if (value.length <= max) return [value];
    const splitAt = value.lastIndexOf(".", max);
    const index = splitAt > max / 2 ? splitAt + 1 : max;
    const first = value.slice(0, index);
    const remainder = value.slice(index);
    return remainder.length <= max ? [first, remainder] : [first, `${remainder.slice(0, max - 1)}…`];
}

const NODE_CELL_WIDTH = 216;
const NODE_CELL_HEIGHT = 184;

function graphHeight(nodeCount, width) {
    const columns = Math.max(1, Math.floor(width / NODE_CELL_WIDTH));
    return Math.max(440, Math.ceil(nodeCount / columns) * NODE_CELL_HEIGHT);
}

function layout(nodes, width, height) {
    const columns = Math.min(nodes.length, Math.max(1, Math.floor(width / NODE_CELL_WIDTH)));
    const rows = Math.ceil(nodes.length / columns);
    const cellWidth = width / columns;
    const cellHeight = Math.max(NODE_CELL_HEIGHT, height / Math.max(rows, 1));
    return new Map(nodes.map((node, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        return [node.id, savedPositions.get(node.id) || {
            x: Math.min(width - 104, column * cellWidth + cellWidth / 2),
            y: row * cellHeight + cellHeight / 2,
        }];
    }));
}

function metricParts(node) {
    const metrics = node.metrics || {};
    const change = node.change || "unchanged";
    const changeClass = { added: "delta-add", modified: "delta-modified", removed: "delta-remove", deleted: "delta-remove" }[change];
    return [
        { text: `+${metrics.lines_added || 0}`, className: "delta-add" },
        { text: " / " },
        { text: `−${metrics.lines_removed || 0}`, className: "delta-remove" },
        { text: " · " },
        node.kind === "function" || node.kind === "method"
            ? { text: `complexity ${metrics.complexity_current ?? "—"}` }
            : { text: change, className: changeClass },
    ];
}

function metricText(node) {
    return metricParts(node).map((part) => part.text).join("");
}

function control(label, title, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", handler);
    return button;
}

export function resizeGraph(container) {
    graphResizers.get(container.querySelector(":scope > svg.graph-canvas"))?.();
}

export function renderGraph(container, nodes, edges, onSelect) {
    container.replaceChildren();
    if (!nodes.length) {
        const empty = document.createElement("div");
        empty.className = "graph-empty";
        empty.textContent = "No items at this level.";
        container.append(empty);
        return;
    }
    let width = Math.max(container.clientWidth || 320, 320);
    let height = graphHeight(nodes.length, width);
    const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", class: "graph-canvas" });
    const defs = svg("defs");
    const marker = svg("marker", {
        id: "arrow", viewBox: "0 0 10 10", refX: 8, refY: 5,
        markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse",
    });
    marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z" }));
    defs.append(marker);
    root.append(defs);
    const viewport = svg("g", { class: "graph-viewport" });
    root.append(viewport);
    const positions = layout(nodes, width, height);
    const nodeGroups = new Map();
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edgeRecords = [];
    const highlightEdges = (nodeId) => {
        root.classList.toggle("focus-edges", nodeId !== null);
        for (const record of edgeRecords) {
            record.path.classList.toggle(
                "edge-active",
                nodeId !== null && (record.edge.source === nodeId || record.edge.target === nodeId),
            );
        }
    };
    if (nodes.length > 24) root.classList.add("graph-dense");
    const transform = { x: 0, y: 0, scale: 1 };
    let activeDrag = null;
    let autoFit = true;

    const updateTransform = () => {
        viewport.setAttribute("transform", `translate(${transform.x} ${transform.y}) scale(${transform.scale})`);
    };
    const updateEdge = (record) => {
        const source = positions.get(record.edge.source);
        const target = positions.get(record.edge.target);
        record.path.setAttribute(
            "d",
            `M ${source.x} ${source.y} C ${(source.x + target.x) / 2} ${source.y}, ${(source.x + target.x) / 2} ${target.y}, ${target.x} ${target.y}`,
        );
        if (record.label) {
            record.label.setAttribute("x", String((source.x + target.x) / 2));
            record.label.setAttribute("y", String((source.y + target.y) / 2 - 6));
        }
    };
    const pointForEvent = (event) => {
        const point = root.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        return point.matrixTransform(root.getScreenCTM().inverse());
    };
    const zoomAt = (factor, point = { x: width / 2, y: height / 2 }) => {
        autoFit = false;
        const next = Math.max(.25, Math.min(3, transform.scale * factor));
        transform.x = point.x - (point.x - transform.x) * (next / transform.scale);
        transform.y = point.y - (point.y - transform.y) * (next / transform.scale);
        transform.scale = next;
        updateTransform();
    };
    const fit = () => {
        autoFit = true;
        const values = [...positions.values()];
        const minX = Math.min(...values.map((item) => item.x)) - 112;
        const maxX = Math.max(...values.map((item) => item.x)) + 112;
        const minY = Math.min(...values.map((item) => item.y)) - 68;
        const maxY = Math.max(...values.map((item) => item.y)) + 68;
        const scale = Math.max(.25, Math.min(1.5, Math.min(width / (maxX - minX), height / (maxY - minY)) * .92));
        transform.scale = scale;
        transform.x = (width - (minX + maxX) * scale) / 2;
        transform.y = (height - (minY + maxY) * scale) / 2;
        updateTransform();
    };

    for (const edge of edges.filter((item) => nodeIds.has(item.source) && nodeIds.has(item.target))) {
        const path = svg("path", {
            class: `edge edge-${edge.change || "unchanged"}`,
            "marker-end": "url(#arrow)",
            tabindex: "0",
        });
        const description = `${edge.type}: ${edge.count || 1} relationship${edge.count === 1 ? "" : "s"}`;
        const title = svg("title");
        title.textContent = description;
        path.append(title);
        path.addEventListener("click", (event) => {
            event.stopPropagation();
            onSelect(edge);
        });
        path.addEventListener("keydown", (event) => event.key === "Enter" && onSelect(edge));
        viewport.append(path);
        let label = null;
        if ((edge.count || 1) > 1) {
            label = svg("text", { class: "edge-label" });
            label.textContent = String(edge.count);
            viewport.append(label);
        }
        const record = { edge, path, label };
        edgeRecords.push(record);
        updateEdge(record);
    }

    for (const node of nodes) {
        const point = positions.get(node.id);
        const group = svg("g", {
            class: `node node-${node.change || "unchanged"}`,
            transform: `translate(${point.x} ${point.y})`,
            tabindex: "0",
            role: "button",
            "aria-label": `${displayName(node)}, ${metricText(node)}, ${node._attention_count || 0} attention findings`,
        });
        const title = svg("title");
        title.textContent = `${displayName(node)}\n${metricText(node)}${node._attention_count ? `\n${node._attention_count} attention findings · highest impact ${node._attention_score}` : ""}`;
        group.append(title, svg("rect", { x: -96, y: -52, width: 192, height: 104, rx: 6 }));
        const kind = svg("text", { x: -80, y: -28, class: "node-kind" });
        kind.textContent = (node.kind || "item").toUpperCase();
        wrapLabel(displayName(node)).forEach((text, index) => {
            const name = svg("text", { x: -80, y: -5 + index * 16, class: "node-name" });
            name.textContent = text;
            group.append(name);
        });
        const metric = svg("text", { x: -80, y: 37, class: "node-metric" });
        for (const part of metricParts(node)) {
            const span = svg("tspan", part.className ? { class: part.className } : {});
            span.textContent = part.text;
            metric.append(span);
        }
        group.append(kind, metric);
        if (node._attention_count) {
            group.append(svg("circle", {
                cx: 79, cy: -36, r: 13,
                class: `attention-badge severity-${node._attention_severity || "medium"}`,
            }));
            const count = svg("text", { x: 79, y: -32, class: "attention-count" });
            count.textContent = String(node._attention_count);
            group.append(count);
        }
        group.addEventListener("pointerdown", (event) => {
            event.stopPropagation();
            event.preventDefault();
            group.dataset.dragMoved = "false";
            activeDrag = {
                node,
                group,
                point,
                last: pointForEvent(event),
                pointerId: event.pointerId,
            };
            root.setPointerCapture(event.pointerId);
            group.classList.add("dragging");
        });
        group.addEventListener("pointerenter", () => highlightEdges(node.id));
        group.addEventListener("pointerleave", () => highlightEdges(null));
        group.addEventListener("focus", () => highlightEdges(node.id));
        group.addEventListener("blur", () => highlightEdges(null));
        group.addEventListener("keydown", (event) => event.key === "Enter" && onSelect(node));
        viewport.append(group);
        nodeGroups.set(node.id, group);
    }

    let panStart = null;
    root.addEventListener("pointerdown", (event) => {
        if (event.target.closest?.(".node")) return;
        panStart = pointForEvent(event);
        root.setPointerCapture(event.pointerId);
        root.classList.add("panning");
    });
    root.addEventListener("pointermove", (event) => {
        if (activeDrag && root.hasPointerCapture(event.pointerId)) {
            const current = pointForEvent(event);
            const dx = (current.x - activeDrag.last.x) / transform.scale;
            const dy = (current.y - activeDrag.last.y) / transform.scale;
            if (Math.abs(dx) + Math.abs(dy) > 1) {
                activeDrag.group.dataset.dragMoved = "true";
                autoFit = false;
            }
            activeDrag.point.x += dx;
            activeDrag.point.y += dy;
            activeDrag.last = current;
            savedPositions.set(activeDrag.node.id, { ...activeDrag.point });
            activeDrag.group.setAttribute("transform", `translate(${activeDrag.point.x} ${activeDrag.point.y})`);
            edgeRecords
                .filter((record) => record.edge.source === activeDrag.node.id || record.edge.target === activeDrag.node.id)
                .forEach(updateEdge);
            return;
        }
        if (!panStart || !root.hasPointerCapture(event.pointerId)) return;
        autoFit = false;
        const current = pointForEvent(event);
        transform.x += current.x - panStart.x;
        transform.y += current.y - panStart.y;
        panStart = current;
        updateTransform();
    });
    root.addEventListener("pointerup", (event) => {
        if (activeDrag) {
            const completedDrag = activeDrag;
            const moved = completedDrag.group.dataset.dragMoved === "true";
            completedDrag.group.classList.remove("dragging");
            completedDrag.group.dataset.dragMoved = "false";
            activeDrag = null;
            root.releasePointerCapture(event.pointerId);
            resizeGraph(container);
            if (!moved) onSelect(completedDrag.node);
            return;
        }
        panStart = null;
        root.releasePointerCapture(event.pointerId);
        root.classList.remove("panning");
        resizeGraph(container);
    });
    root.addEventListener("pointercancel", () => {
        activeDrag?.group.classList.remove("dragging");
        activeDrag = null;
        panStart = null;
        root.classList.remove("panning");
        resizeGraph(container);
    });
    root.addEventListener("wheel", (event) => {
        event.preventDefault();
        zoomAt(event.deltaY < 0 ? 1.12 : .89, pointForEvent(event));
    }, { passive: false });

    const controls = document.createElement("div");
    controls.className = "graph-viewport-controls";
    controls.append(
        control("+", "Zoom in", () => zoomAt(1.2)),
        control("−", "Zoom out", () => zoomAt(.8)),
        control("Fit", "Fit all nodes", fit),
    );
    const hint = document.createElement("span");
    hint.textContent = "Drag tiles · drag background · wheel to zoom";
    controls.append(hint);
    container.append(root, controls);
    fit();
    graphResizers.set(root, () => {
        const measuredWidth = container.clientWidth;
        if (!measuredWidth || activeDrag || panStart) return;
        const nextWidth = Math.max(measuredWidth, 320);
        if (nextWidth === width) return;
        width = nextWidth;
        height = graphHeight(nodes.length, width);
        root.setAttribute("viewBox", `0 0 ${width} ${height}`);
        for (const [id, point] of layout(nodes, width, height)) {
            Object.assign(positions.get(id), point);
            nodeGroups.get(id).setAttribute("transform", `translate(${point.x} ${point.y})`);
        }
        edgeRecords.forEach(updateEdge);
        if (autoFit) fit();
    });
}
