import { Endpoint, Logger, ServerNode } from "@matter/main";
import { ClientNode, CommissioningClient, OtaUpdateAvailableDetails, SoftwareUpdateManager } from "@matter/node";
import { OtaSoftwareUpdateProviderServer } from "@matter/node/behaviors/ota-software-update-provider";
import { OtaProviderEndpoint } from "@matter/node/endpoints/ota-provider";
import { BdxProtocol, BdxSession, FabricManager, FileDesignator, Invoke, PeerAddress } from "@matter/protocol";
import { EndpointNumber, Status, VendorId } from "@matter/types";
import { OtaSoftwareUpdateProvider } from "@matter/types/clusters/ota-software-update-provider";
import { OtaSoftwareUpdateRequestor } from "@matter/types/clusters/ota-software-update-requestor";
import { readAttributes } from "./attributes.js";
import { HttpError } from "./http-error.js";

const logger = Logger.get("Firmware");

const REQUESTOR_ENDPOINT = 0;
const BASIC_INFORMATION_CLUSTER = 0x28;
const VENDOR_ID = 0x2;
const PRODUCT_ID = 0x4;
const SOFTWARE_VERSION = 0x9;
const SOFTWARE_VERSION_STRING = 0xa;

const REQUEST_TIMEOUT_MS = 3 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface FirmwareImage {
    filename: string;
    vendor_id: number;
    product_id: number;
    version: number;
    version_string: string;
    size: number;
}

type UpdateState = "waiting" | "downloading" | "installing" | "failed";

interface Update {
    peerAddress: PeerAddress;
    image: FirmwareImage;
    state: UpdateState;
    since: number;
    session?: BdxSession;
    error?: string;
}

/**
 * Answers a switch's QueryImage with a stored image, but only for the switch and version the user started an
 * update for. The default implementation would look the product up in the DCL, where test vendor ids never appear.
 */
class SwitchOtaProvider extends OtaSoftwareUpdateProviderServer {
    protected override checkUpdateAvailable(
        request: OtaSoftwareUpdateProvider.QueryImageRequest,
        peerAddress: PeerAddress,
    ) {
        return this.endpoint.act(async agent => {
            const manager = agent.get(SoftwareUpdateManager);
            const images = await manager.internal.otaService.find({
                vendorId: request.vendorId,
                productId: request.productId,
            });
            const image = images
                .filter(i => i.softwareVersion > request.softwareVersion && manager.hasConsent(peerAddress, i.softwareVersion))
                .sort((a, b) => b.softwareVersion - a.softwareVersion)[0];
            if (image === undefined) return undefined;
            return {
                newSoftwareVersion: image.softwareVersion,
                newSoftwareVersionString: image.softwareVersionString,
                fileDesignator: new FileDesignator(`ota/${image.filename}`),
                consentRequired: false,
            } satisfies OtaUpdateAvailableDetails;
        });
    }
}

/** Stores uploaded Matter OTA images and pushes one to a switch when the user asks for it. */
export class FirmwareUpdates {
    readonly #updates = new Map<number, Update>();
    #watchingTransfers = false;

    private constructor(
        private readonly server: ServerNode,
        private readonly provider: Endpoint,
    ) {}

    /** Call before the server starts. */
    static async create(server: ServerNode) {
        const provider = new Endpoint(OtaProviderEndpoint.with(SwitchOtaProvider), { id: "ota-provider" });
        await server.add(provider);
        return new FirmwareUpdates(server, provider);
    }

    async images(): Promise<FirmwareImage[]> {
        const service = await this.#manager(manager => manager.internal.otaService);
        const images = await service.find({ mode: "local" });
        return images.map(image => ({
            filename: image.filename,
            vendor_id: image.vendorId,
            product_id: image.productId,
            version: image.softwareVersion,
            version_string: image.softwareVersionString,
            size: image.size,
        }));
    }

    async upload(bytes: Uint8Array) {
        const service = await this.#manager(manager => manager.internal.otaService);
        const image = new Blob([new Uint8Array(bytes)]);
        let info;
        try {
            info = await service.updateInfoFromStream(image.stream(), "file://upload");
        } catch (error) {
            throw new HttpError(400, `Not a Matter OTA image: ${error instanceof Error ? error.message : error}`);
        }
        await service.store(image.stream(), info, "local");
        logger.info(`Stored firmware ${info.softwareVersionString} for ${info.vid}/${info.pid}`);
    }

    async delete(filename: string) {
        await this.#image(filename);
        const service = await this.#manager(manager => manager.internal.otaService);
        await service.delete({ filename });
    }

    async start(nodeId: number, peer: ClientNode, filename: string) {
        if ([...this.#updates.values()].some(u => u.state === "waiting" || u.state === "downloading")) {
            throw new HttpError(409, "Another switch is downloading an update");
        }
        const image = await this.#image(filename);
        const current = await readFirmware(peer);
        if (image.vendor_id !== current.vendor_id || image.product_id !== current.product_id) {
            throw new HttpError(400, "This firmware is for a different product");
        }
        if (image.version <= current.version) {
            throw new HttpError(400, `The switch already runs ${current.version_string}`);
        }

        this.#watchTransfers();
        const peerAddress = PeerAddress(peer.stateOf(CommissioningClient).peerAddress!);
        await this.#manager(manager =>
            manager.addUpdateConsent(peerAddress, {
                vendorId: VendorId(image.vendor_id),
                productId: image.product_id,
                targetSoftwareVersion: image.version,
            }),
        );
        await this.#announce(peer, peerAddress);
        this.#updates.set(nodeId, { peerAddress, image, state: "waiting", since: Date.now() });
        logger.info(`Offered ${image.version_string} to node ${nodeId}`);
    }

    /**
     * The switch's current firmware and the progress of an update. While the switch restarts into new firmware it
     * can't be read, so then only the update is returned.
     */
    async firmwareOf(nodeId: number, peer: ClientNode) {
        const update = this.#updates.get(nodeId);
        let current;
        try {
            current = await readFirmware(peer);
        } catch (error) {
            if (update?.state !== "installing") throw error;
        }

        if (update !== undefined && current !== undefined && current.version >= update.image.version) {
            logger.info(`Node ${nodeId} now runs ${current.version_string}`);
            await this.#finish(nodeId, update);
            return { ...current, update: undefined };
        }
        if (update?.state === "waiting" && Date.now() - update.since > REQUEST_TIMEOUT_MS) {
            await this.#fail(update, "The switch did not ask for the update. Check that it can reach Home Assistant.");
        }
        if (update?.state === "installing" && Date.now() - update.since > INSTALL_TIMEOUT_MS) {
            await this.#fail(update, `The switch kept its old firmware${current ? ` (${current.version_string})` : ""}.`);
        }
        return { ...current, update: update && progressOf(update) };
    }

    async forget(nodeId: number) {
        const update = this.#updates.get(nodeId);
        if (update !== undefined) await this.#finish(nodeId, update);
    }

    async #image(filename: string) {
        const image = (await this.images()).find(i => i.filename === filename);
        if (image === undefined) throw new HttpError(404, `No firmware ${filename}`);
        return image;
    }

    async #announce(peer: ClientNode, peerAddress: PeerAddress) {
        const fabric = this.server.env.get(FabricManager).for(peerAddress.fabricIndex);
        const request = Invoke({
            endpoint: EndpointNumber(REQUESTOR_ENDPOINT),
            cluster: OtaSoftwareUpdateRequestor,
            command: "announceOtaProvider",
            fields: {
                providerNodeId: fabric.rootNodeId,
                vendorId: fabric.rootVendorId,
                announcementReason: OtaSoftwareUpdateRequestor.AnnouncementReason.UpdateAvailable,
                endpoint: this.provider.number,
            },
        });
        for await (const chunk of peer.interaction.invoke(request)) {
            for (const result of chunk) {
                if (result.kind === "cmd-status" && result.status !== Status.Success) {
                    throw new HttpError(502, `The switch refused the update offer (status ${result.status})`);
                }
            }
        }
    }

    #watchTransfers() {
        if (this.#watchingTransfers) return;
        this.#watchingTransfers = true;
        this.server.env.get(BdxProtocol).sessionStarted.on(session => {
            const update = [...this.#updates.values()].find(u => PeerAddress.is(u.peerAddress, session.peerAddress));
            if (update === undefined) return;
            update.session = session;
            update.error = undefined;
            this.#enter(update, "downloading");
            session.progressFinished.on(() => this.#enter(update, "installing"));
            session.progressCancelled.on(() => {
                this.#fail(update, "The download was interrupted").catch(error => logger.warn(`${error}`));
            });
        });
    }

    #enter(update: Update, state: UpdateState) {
        update.state = state;
        update.since = Date.now();
    }

    async #fail(update: Update, error: string) {
        if (update.state === "failed") return;
        this.#enter(update, "failed");
        update.error = error;
        logger.warn(`Update to ${update.image.version_string} failed: ${error}`);
        await this.#manager(manager => manager.removeConsent(update.peerAddress));
    }

    async #finish(nodeId: number, update: Update) {
        this.#updates.delete(nodeId);
        if (update.state !== "failed") {
            await this.#manager(manager => manager.removeConsent(update.peerAddress));
        }
    }

    async #manager<T>(action: (manager: SoftwareUpdateManager) => T | Promise<T>) {
        return this.provider.act(agent => action(agent.get(SoftwareUpdateManager)));
    }
}

async function readFirmware(peer: ClientNode) {
    const values = await readAttributes(peer, 0, BASIC_INFORMATION_CLUSTER, [
        VENDOR_ID,
        PRODUCT_ID,
        SOFTWARE_VERSION,
        SOFTWARE_VERSION_STRING,
    ]);
    return {
        vendor_id: values[VENDOR_ID] as number,
        product_id: values[PRODUCT_ID] as number,
        version: values[SOFTWARE_VERSION] as number,
        version_string: values[SOFTWARE_VERSION_STRING] as string,
    };
}

function progressOf({ image, state, session, error }: Update) {
    return {
        version_string: image.version_string,
        state,
        transferred: state === "downloading" ? session?.transferredBytes : undefined,
        total: state === "downloading" ? session?.dataLength : undefined,
        error,
    };
}
