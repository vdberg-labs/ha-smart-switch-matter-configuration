import type { ClientNode } from "@matter/node";
import { Read } from "@matter/protocol";
import { AttributeId, ClusterId, EndpointNumber } from "@matter/types";
import { HttpError } from "./http-error.js";

/** Reads attributes of one cluster straight from the device, keyed by attribute id. */
export async function readAttributes(peer: ClientNode, endpoint: number, cluster: number, attributeIds: number[]) {
    const attributes = attributeIds.map(attributeId => ({
        endpointId: EndpointNumber(endpoint),
        clusterId: ClusterId(cluster),
        attributeId: AttributeId(attributeId),
    }));
    const values: Record<number, unknown> = {};
    const request = { ...Read({ attributes }), includeKnownVersions: true };
    for await (const chunk of peer.interaction.read(request)) {
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
