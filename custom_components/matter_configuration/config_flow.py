from __future__ import annotations

import asyncio
import logging

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from matter_server.client.client import MatterClient

from .const import (
    CONF_ADDON_URL,
    CONF_DEVICE_ID,
    CONF_ENDPOINT_ID,
    CONF_MATTER_WS_URL,
    CONF_NODE_ID,
    DEFAULT_ADDON_URL,
    DEFAULT_ENDPOINT_ID,
    DEFAULT_MATTER_WS_URL,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

# Long enough for the app's own 90 s discovery plus commissioning over Thread.
COMMISSION_TIMEOUT = aiohttp.ClientTimeout(total=180)


class AddonUnavailable(Exception):
    pass


class MatterConfigurationConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._url: str | None = None
        self._addon_url: str | None = None
        self._nodes: dict[int, str] = {}

    async def async_step_user(self, user_input: dict | None = None):
        errors: dict[str, str] = {}

        if user_input is not None:
            self._url = user_input[CONF_MATTER_WS_URL]
            self._addon_url = user_input[CONF_ADDON_URL]
            try:
                await self._async_check_addon()
                self._nodes = await self._async_list_nodes(self._url)
            except AddonUnavailable:
                errors["base"] = "addon_unavailable"
            except Exception:
                _LOGGER.exception("Failed to list nodes from Matter Server at %s", self._url)
                errors["base"] = "cannot_connect"
            else:
                if not self._nodes:
                    errors["base"] = "no_nodes"
                else:
                    return await self.async_step_node()

        schema = vol.Schema(
            {
                vol.Required(CONF_MATTER_WS_URL, default=self._url or DEFAULT_MATTER_WS_URL): str,
                vol.Required(CONF_ADDON_URL, default=self._addon_url or DEFAULT_ADDON_URL): str,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def async_step_node(self, user_input: dict | None = None):
        errors: dict[str, str] = {}

        if user_input is not None:
            node_id = int(user_input[CONF_NODE_ID])
            endpoint_id = int(user_input[CONF_ENDPOINT_ID])
            await self.async_set_unique_id(f"{node_id}-{endpoint_id}")
            self._abort_if_unique_id_configured()
            try:
                device_id = await self._async_pair_addon(node_id)
            except Exception:
                _LOGGER.exception("Failed to pair the app with node %s", node_id)
                errors["base"] = "pairing_failed"
            else:
                return self.async_create_entry(
                    title=f"Gesture config ({self._nodes.get(node_id, f'node {node_id}')})",
                    data={
                        CONF_MATTER_WS_URL: self._url,
                        CONF_ADDON_URL: self._addon_url,
                        CONF_DEVICE_ID: device_id,
                        CONF_NODE_ID: node_id,
                        CONF_ENDPOINT_ID: endpoint_id,
                    },
                )

        options = [
            selector.SelectOptionDict(value=str(node_id), label=label)
            for node_id, label in sorted(self._nodes.items())
        ]
        schema = vol.Schema(
            {
                vol.Required(CONF_NODE_ID): selector.SelectSelector({"options": options}),
                vol.Optional(CONF_ENDPOINT_ID, default=DEFAULT_ENDPOINT_ID): vol.Coerce(int),
            }
        )
        return self.async_show_form(step_id="node", data_schema=schema, errors=errors)

    async def _async_check_addon(self) -> None:
        session = async_get_clientsession(self.hass)
        try:
            async with session.get(
                f"{self._addon_url.rstrip('/')}/health", timeout=aiohttp.ClientTimeout(total=10)
            ) as response:
                if response.status != 200:
                    raise AddonUnavailable
        except (aiohttp.ClientError, TimeoutError) as err:
            raise AddonUnavailable from err

    async def _async_pair_addon(self, node_id: int) -> str:
        session = async_get_clientsession(self.hass)
        async with MatterClient(self._url, session) as client:
            ready = asyncio.Event()
            listen_task = asyncio.create_task(client.start_listening(ready))
            try:
                await asyncio.wait_for(ready.wait(), timeout=15)
                window = await client.open_commissioning_window(node_id)
            finally:
                listen_task.cancel()

        async with session.post(
            f"{self._addon_url.rstrip('/')}/devices",
            json={"manual_code": window.setup_manual_code},
            timeout=COMMISSION_TIMEOUT,
        ) as response:
            body = await response.json()
            if response.status != 201:
                raise RuntimeError(body.get("error", f"HTTP {response.status}"))
            return body["device_id"]

    async def _async_list_nodes(self, url: str) -> dict[int, str]:
        session = async_get_clientsession(self.hass)
        async with MatterClient(url, session) as client:
            ready = asyncio.Event()
            listen_task = asyncio.create_task(client.start_listening(ready))
            try:
                await asyncio.wait_for(ready.wait(), timeout=15)
                nodes: dict[int, str] = {}
                for node in client.get_nodes():
                    label = node.name
                    if not label:
                        info = node.device_info
                        label = getattr(info, "productName", None) if info else None
                    if not label:
                        label = "Unnamed device"
                    nodes[node.node_id] = f"{label} (node {node.node_id})"
                return nodes
            finally:
                listen_task.cancel()
