from __future__ import annotations

import asyncio
import logging

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from matter_server.client.client import MatterClient

from .const import (
    CONF_ENDPOINT_ID,
    CONF_MATTER_WS_URL,
    CONF_NODE_ID,
    DEFAULT_ENDPOINT_ID,
    DEFAULT_MATTER_WS_URL,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

STEP_URL_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_MATTER_WS_URL, default=DEFAULT_MATTER_WS_URL): str,
    }
)


class MatterConfigurationConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._url: str | None = None
        self._nodes: dict[int, str] = {}

    async def async_step_user(self, user_input: dict | None = None):
        errors: dict[str, str] = {}

        if user_input is not None:
            self._url = user_input[CONF_MATTER_WS_URL]
            try:
                self._nodes = await self._async_list_nodes(self._url)
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
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def async_step_node(self, user_input: dict | None = None):
        if user_input is not None:
            node_id = int(user_input[CONF_NODE_ID])
            endpoint_id = int(user_input[CONF_ENDPOINT_ID])
            await self.async_set_unique_id(f"{node_id}-{endpoint_id}")
            self._abort_if_unique_id_configured()
            return self.async_create_entry(
                title=f"Gesture config ({self._nodes.get(node_id, f'node {node_id}')})",
                data={
                    CONF_MATTER_WS_URL: self._url,
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
        return self.async_show_form(step_id="node", data_schema=schema)

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
