import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Environment, Logger, Seconds, ServerNode } from "@matter/main";
import { ControllerBehavior } from "@matter/node";
import { Write, WriteResult } from "@matter/protocol";
import { AttributeId, ClusterId, EndpointNumber, TlvBoolean, TlvUInt16, TlvUInt8 } from "@matter/types";
import { readAttributes } from "./attributes.js";
import { FirmwareUpdates } from "./firmware.js";
import { HttpError } from "./http-error.js";

const logger = Logger.get("SmartSwitchConfig");

const CLUSTER_ID = 0xfff1fc01;
const DEFAULT_ENDPOINT = 3;

// Ranges mirror shared/config/gesture_config.h in the firmware.
const ATTRIBUTES = new Map<number, { tlv: typeof TlvUInt8 | typeof TlvUInt16; min: number; max: number } | { tlv: typeof TlvBoolean }>([
    [0xfff10000, { tlv: TlvUInt8, min: 1, max: 2 }],
    [0xfff10001, { tlv: TlvUInt16, min: 1, max: 50 }],
    [0xfff10002, { tlv: TlvUInt16, min: 200, max: 5000 }],
    [0xfff10003, { tlv: TlvUInt16, min: 50, max: 2000 }],
    [0xfff10004, { tlv: TlvUInt8, min: 1, max: 5 }],
    [0xfff10005, { tlv: TlvBoolean }],
    [0xfff10006, { tlv: TlvUInt8, min: 1, max: 5 }],
    [0xfff10007, { tlv: TlvBoolean }],
]);

const COMMISSION_TIMEOUT = Seconds(90);
const WS_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 4096;
const MAX_FIRMWARE_BYTES = 2 * 1024 * 1024;

const DATA_DIR = process.env.SMART_SWITCH_DATA ?? "/data";
const DEVICES_PATH = join(DATA_DIR, "devices.json");
const PAGE_PATH = join(import.meta.dirname, "..", "index.html");
const INGRESS_PEER = process.env.INGRESS_PEER ?? "172.30.32.2";
const HA_WS_URL = process.env.HA_WS_URL ?? "ws://supervisor/core/websocket";
const MATTER_WS_URLS = (process.env.MATTER_WS_URLS ?? "ws://172.30.32.1:5580/ws,ws://127.0.0.1:5580/ws").split(",");

interface PairedDevice {
    node_id: number;
    peer_id: string;
    endpoint: number;
}

interface MatterNode {
    node_id: number;
    attributes: Record<string, unknown>;
}

function readOptions(): { network_interface?: string } {
    try {
        return JSON.parse(readFileSync(join(DATA_DIR, "options.json"), "utf8"));
    } catch {
        return {};
    }
}

function loadDevices(): PairedDevice[] {
    return existsSync(DEVICES_PATH) ? JSON.parse(readFileSync(DEVICES_PATH, "utf8")) : [];
}

function saveDevices(devices: PairedDevice[]) {
    const temp = `${DEVICES_PATH}.tmp`;
    writeFileSync(temp, JSON.stringify(devices));
    renameSync(temp, DEVICES_PATH);
}

async function readBytes(req: IncomingMessage, limit: number) {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
        length += chunk.length;
        if (length > limit) throw new HttpError(413, "Body too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = (await readBytes(req, MAX_BODY_BYTES)).toString("utf8");
    try {
        const body = JSON.parse(raw || "{}");
        if (typeof body !== "object" || body === null) throw new Error();
        return body;
    } catch {
        throw new HttpError(400, "Body must be a JSON object");
    }
}

function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

/** Runs one request/response conversation over a short-lived WebSocket. */
function converse<T>(url: string, onMessage: (message: any, send: (data: unknown) => void, done: (value: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => finish(() => reject(new Error(`Timed out talking to ${url}`))), WS_TIMEOUT_MS);
        let finished = false;
        const finish = (settle: () => void) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            socket.close();
            settle();
        };
        socket.onerror = () => finish(() => reject(new Error(`Could not connect to ${url}`)));
        socket.onclose = () => finish(() => reject(new Error(`Connection to ${url} closed`)));
        socket.onmessage = event => {
            try {
                onMessage(
                    JSON.parse(String(event.data)),
                    data => socket.send(JSON.stringify(data)),
                    value => finish(() => resolve(value)),
                );
            } catch (error) {
                finish(() => reject(error));
            }
        };
    });
}

async function matterCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    let lastError: unknown;
    for (const url of MATTER_WS_URLS) {
        let connected = false;
        try {
            return await converse<T>(url, (message, sendMessage, done) => {
                if (!connected) {
                    connected = true;
                    sendMessage({ message_id: "1", command, args });
                    return;
                }
                if (message.message_id !== "1") return;
                if (message.error_code !== undefined) {
                    throw new HttpError(502, `Matter Server: ${message.details ?? message.error_code}`);
                }
                done(message.result as T);
            });
        } catch (error) {
            if (error instanceof HttpError || connected) throw error;
            lastError = error;
        }
    }
    throw new HttpError(502, `The Matter Server app is not reachable: ${lastError}`);
}

/** Node names as shown in Home Assistant, so the list matches what the user sees there. */
async function homeAssistantNames(): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) return names;
    try {
        const devices = await converse<any[]>(HA_WS_URL, (message, sendMessage, done) => {
            if (message.type === "auth_required") sendMessage({ type: "auth", access_token: token });
            else if (message.type === "auth_ok") sendMessage({ id: 1, type: "config/device_registry/list" });
            else if (message.type === "auth_invalid") throw new Error("Home Assistant rejected the app's token");
            else if (message.id === 1) done(message.result ?? []);
        });
        for (const device of devices) {
            for (const [domain, identifier] of device.identifiers ?? []) {
                const match = domain === "matter" && /-([0-9a-f]{16})-MatterNodeDevice$/i.exec(identifier);
                if (match) names.set(parseInt(match[1], 16), device.name_by_user || device.name);
            }
        }
    } catch (error) {
        logger.warn(`Could not read device names from Home Assistant: ${error}`);
    }
    return names;
}

function configEndpoint(node: MatterNode): number | undefined {
    for (const key of Object.keys(node.attributes ?? {})) {
        const [endpoint, cluster] = key.split("/");
        if (Number(cluster) === CLUSTER_ID) return Number(endpoint);
    }
    return undefined;
}

async function main() {
    const options = readOptions();
    const vars = Environment.default.vars;
    vars.set("storage.path", DATA_DIR);
    if (options.network_interface) vars.set("mdns.networkInterface", options.network_interface);

    const server = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
        id: "smart-switch-config",
        network: { ble: false },
        commissioning: { enabled: false },
        controller: { adminFabricLabel: "Smart Switch Config" },
    });
    const firmware = await FirmwareUpdates.create(server);
    await server.start();

    let devices = loadDevices();
    let pairing = false;

    function deviceOf(nodeId: number) {
        const device = devices.find(d => d.node_id === nodeId);
        if (device === undefined) throw new HttpError(404, `Switch ${nodeId} has not been added`);
        const peer = server.peers.get(device.peer_id);
        if (peer === undefined) throw new HttpError(404, `Switch ${nodeId} has no pairing`);
        return { device, peer };
    }

    async function listState() {
        const [nodes, names] = await Promise.all([matterCommand<MatterNode[]>("start_listening"), homeAssistantNames()]);
        const candidates = nodes.filter(node => configEndpoint(node) !== undefined);
        const shown = candidates.length > 0 ? candidates : nodes;
        const label = (node: MatterNode) => names.get(node.node_id) ?? `Matter device ${node.node_id}`;
        const byId = new Map(nodes.map(node => [node.node_id, node]));
        return {
            available: shown
                .filter(node => !devices.some(d => d.node_id === node.node_id))
                .map(node => ({ node_id: node.node_id, name: label(node) }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            devices: devices.map(d => {
                const node = byId.get(d.node_id);
                return { node_id: d.node_id, name: node ? label(node) : `Matter device ${d.node_id}` };
            }),
        };
    }

    async function addDevice(nodeId: unknown) {
        if (typeof nodeId !== "number" || !Number.isSafeInteger(nodeId)) throw new HttpError(400, "node_id is required");
        if (devices.some(d => d.node_id === nodeId)) throw new HttpError(409, "This switch has already been added");
        if (pairing) throw new HttpError(409, "Another switch is being paired");

        pairing = true;
        try {
            const nodes = await matterCommand<MatterNode[]>("start_listening");
            const node = nodes.find(n => n.node_id === nodeId);
            if (node === undefined) throw new HttpError(404, `Matter Server does not know node ${nodeId}`);

            const window = await matterCommand<{ setup_manual_code: string }>("open_commissioning_window", { node_id: nodeId });
            const peer = await server.peers.commission({
                pairingCode: window.setup_manual_code,
                timeout: COMMISSION_TIMEOUT,
                autoSubscribe: false,
            });
            logger.info(`Paired node ${nodeId} as ${peer.id}`);
            devices = [...devices, { node_id: nodeId, peer_id: peer.id, endpoint: configEndpoint(node) ?? DEFAULT_ENDPOINT }];
            saveDevices(devices);
        } finally {
            pairing = false;
        }
    }

    async function removeDevice(nodeId: number) {
        const { peer } = deviceOf(nodeId);
        try {
            await peer.decommission();
        } catch (error) {
            logger.warn(`Node ${nodeId} could not be unpaired cleanly: ${error}`);
        }
        await peer.delete();
        await firmware.forget(nodeId);
        devices = devices.filter(d => d.node_id !== nodeId);
        saveDevices(devices);
    }

    async function readConfig(nodeId: number) {
        const { device, peer } = deviceOf(nodeId);
        return readAttributes(peer, device.endpoint, CLUSTER_ID, [...ATTRIBUTES.keys()]);
    }

    async function writeConfig(nodeId: number, values: unknown) {
        if (typeof values !== "object" || values === null) throw new HttpError(400, "values is required");
        const { device, peer } = deviceOf(nodeId);
        const writes = Object.entries(values).map(([key, value]) => {
            const attributeId = Number(key);
            const attribute = ATTRIBUTES.get(attributeId);
            if (attribute === undefined) throw new HttpError(400, `Unknown attribute ${key}`);
            if ("min" in attribute) {
                if (!Number.isInteger(value) || value < attribute.min || value > attribute.max) {
                    throw new HttpError(400, `Value for ${key} must be ${attribute.min} to ${attribute.max}`);
                }
            } else if (typeof value !== "boolean") {
                throw new HttpError(400, `Value for ${key} must be true or false`);
            }
            return {
                path: {
                    endpointId: EndpointNumber(device.endpoint),
                    clusterId: ClusterId(CLUSTER_ID),
                    attributeId: AttributeId(attributeId),
                },
                data: (attribute.tlv as typeof TlvUInt16).encodeTlv(value as number),
            };
        });
        if (writes.length > 0) WriteResult.assertSuccess(await peer.interaction.write(Write({ writes })));
    }

    async function route(req: IncomingMessage, res: ServerResponse) {
        const parts = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
        const method = req.method;

        if (method === "GET" && parts.length === 0) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return res.end(readFileSync(PAGE_PATH));
        }
        if (parts[0] !== "api") throw new HttpError(404, "Not found");

        if (method === "GET" && parts[1] === "state" && parts.length === 2) return send(res, 200, await listState());
        if (parts[1] === "firmware") return routeFirmware(req, res, parts.slice(2));
        if (parts[1] !== "devices") throw new HttpError(404, "Not found");

        if (method === "POST" && parts.length === 2) {
            await addDevice((await readBody(req)).node_id);
            return send(res, 201, { status: "ok" });
        }

        const nodeId = Number(parts[2]);
        if (!Number.isSafeInteger(nodeId)) throw new HttpError(404, "Not found");
        if (method === "DELETE" && parts.length === 3) {
            await removeDevice(nodeId);
            return send(res, 200, { status: "ok" });
        }
        if (parts[3] === "firmware" && parts.length === 4) {
            const { peer } = deviceOf(nodeId);
            if (method === "GET") return send(res, 200, await firmware.firmwareOf(nodeId, peer));
            if (method === "POST") {
                const { filename } = await readBody(req);
                if (typeof filename !== "string") throw new HttpError(400, "filename is required");
                await firmware.start(nodeId, peer, filename);
                return send(res, 202, { status: "ok" });
            }
        }
        if (parts[3] === "config" && parts.length === 4) {
            if (method === "GET") return send(res, 200, await readConfig(nodeId));
            if (method === "PUT") {
                await writeConfig(nodeId, (await readBody(req)).values);
                return send(res, 200, { status: "ok" });
            }
        }
        throw new HttpError(404, "Not found");
    }

    async function routeFirmware(req: IncomingMessage, res: ServerResponse, parts: string[]) {
        if (req.method === "GET" && parts.length === 0) return send(res, 200, await firmware.images());
        if (req.method === "POST" && parts.length === 0) {
            await firmware.upload(await readBytes(req, MAX_FIRMWARE_BYTES));
            return send(res, 201, { status: "ok" });
        }
        if (req.method === "DELETE" && parts.length === 1) {
            await firmware.delete(decodeURIComponent(parts[0]));
            return send(res, 200, { status: "ok" });
        }
        throw new HttpError(404, "Not found");
    }

    const host = process.env.SMART_SWITCH_BIND ?? "172.30.32.1";
    const port = Number(process.env.SMART_SWITCH_PORT ?? 15581);
    createServer((req, res) => {
        const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
        if (peer !== INGRESS_PEER) return send(res, 403, { error: "Only available through Home Assistant" });
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
