import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { Environment, Logger, Seconds, ServerNode } from "@matter/main";
import { ControllerBehavior } from "@matter/node";
import { Read, Write, WriteResult } from "@matter/protocol";
import { AttributeId, ClusterId, EndpointNumber, TlvBoolean, TlvUInt16, TlvUInt8 } from "@matter/types";

const logger = Logger.get("SmartSwitchConfig");

const CLUSTER_ID = 0xfff1fc01;
const ATTRIBUTE_TLV = new Map<number, typeof TlvUInt8 | typeof TlvUInt16 | typeof TlvBoolean>([
    [0xfff10000, TlvUInt8],
    [0xfff10001, TlvUInt16],
    [0xfff10002, TlvUInt16],
    [0xfff10003, TlvUInt16],
    [0xfff10004, TlvUInt8],
    [0xfff10005, TlvBoolean],
    [0xfff10006, TlvUInt8],
    [0xfff10007, TlvBoolean],
]);

const COMMISSION_TIMEOUT = Seconds(90);
const MAX_BODY_BYTES = 4096;

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

function readOptions(): { network_interface?: string } {
    try {
        return JSON.parse(readFileSync("/data/options.json", "utf8"));
    } catch {
        return {};
    }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "Body too large");
    }
    try {
        const body = JSON.parse(raw || "{}");
        if (typeof body !== "object" || body === null) throw new Error();
        return body;
    } catch {
        throw new HttpError(400, "Body must be a JSON object");
    }
}

function parseEndpoint(value: unknown): EndpointNumber {
    const endpoint = Number(value);
    if (!Number.isInteger(endpoint) || endpoint < 0 || endpoint > 0xfffe) {
        throw new HttpError(400, "Invalid endpoint");
    }
    return EndpointNumber(endpoint);
}

function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

async function main() {
    const options = readOptions();
    const vars = Environment.default.vars;
    vars.set("storage.path", process.env.SMART_SWITCH_DATA ?? "/data");
    if (options.network_interface) vars.set("mdns.networkInterface", options.network_interface);

    const server = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
        id: "smart-switch-config",
        network: { ble: false },
        commissioning: { enabled: false },
        controller: { adminFabricLabel: "Smart Switch Config" },
    });
    await server.start();

    function peerOf(id: string) {
        const peer = server.peers.get(id);
        if (peer === undefined) throw new HttpError(404, `Unknown device ${id}`);
        return peer;
    }

    async function commission(manualCode: unknown): Promise<string> {
        if (typeof manualCode !== "string") throw new HttpError(400, "manual_code is required");
        const peer = await server.peers.commission({
            pairingCode: manualCode.replaceAll("-", ""),
            timeout: COMMISSION_TIMEOUT,
            autoSubscribe: false,
        });
        logger.info(`Commissioned device as ${peer.id}`);
        return peer.id;
    }

    async function readConfig(id: string, endpoint: EndpointNumber) {
        const attributes = [...ATTRIBUTE_TLV.keys()].map(attributeId => ({
            endpointId: endpoint,
            clusterId: ClusterId(CLUSTER_ID),
            attributeId: AttributeId(attributeId),
        }));
        const values: Record<string, unknown> = {};
        const request = { ...Read({ attributes }), includeKnownVersions: true };
        for await (const chunk of peerOf(id).interaction.read(request)) {
            for await (const report of chunk) {
                if (report.kind === "attr-value") {
                    values[report.path.attributeId] = report.value;
                } else if (report.kind === "attr-status") {
                    throw new HttpError(502, `Attribute ${report.path.attributeId} failed with status ${report.status}`);
                }
            }
        }
        return values;
    }

    async function writeAttribute(id: string, endpoint: EndpointNumber, attributeId: number, value: unknown) {
        const tlv = ATTRIBUTE_TLV.get(attributeId);
        if (tlv === undefined) throw new HttpError(404, `Unknown attribute ${attributeId}`);
        const expected = tlv === TlvBoolean ? "boolean" : "number";
        if (typeof value !== expected) throw new HttpError(400, `Value must be a ${expected}`);

        let data;
        try {
            data = (tlv as typeof TlvUInt16).encodeTlv(value as number);
        } catch {
            throw new HttpError(400, "Value out of range");
        }
        const path = { endpointId: endpoint, clusterId: ClusterId(CLUSTER_ID), attributeId: AttributeId(attributeId) };
        const result = await peerOf(id).interaction.write(Write({ writes: [{ path, data }] }));
        WriteResult.assertSuccess(result);
    }

    async function route(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url ?? "/", "http://localhost");
        const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

        if (req.method === "GET" && parts.length === 1 && parts[0] === "health") {
            return send(res, 200, { status: "ok" });
        }
        if (parts[0] !== "devices") throw new HttpError(404, "Not found");

        if (req.method === "POST" && parts.length === 1) {
            const body = await readBody(req);
            return send(res, 201, { device_id: await commission(body.manual_code) });
        }

        const id = parts[1];
        if (req.method === "GET" && parts.length === 3 && parts[2] === "config") {
            return send(res, 200, await readConfig(id, parseEndpoint(url.searchParams.get("endpoint"))));
        }
        if (req.method === "PUT" && parts.length === 4 && parts[2] === "attributes") {
            const body = await readBody(req);
            await writeAttribute(id, parseEndpoint(body.endpoint), Number(parts[3]), body.value);
            return send(res, 200, { status: "ok" });
        }
        if (req.method === "DELETE" && parts.length === 2) {
            const peer = peerOf(id);
            await peer.decommission();
            await peer.delete();
            return send(res, 200, { status: "ok" });
        }
        throw new HttpError(404, "Not found");
    }

    const host = process.env.SMART_SWITCH_BIND ?? "172.30.32.1";
    const port = Number(process.env.SMART_SWITCH_PORT ?? 5581);
    createServer((req, res) => {
        route(req, res).catch(error => {
            const status = error instanceof HttpError ? error.status : 502;
            logger.warn(`${req.method} ${req.url}: ${error}`);
            send(res, status, { error: error instanceof Error ? error.message : String(error) });
        });
    }).listen(port, host, () => logger.info(`Listening on ${host}:${port}`));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
