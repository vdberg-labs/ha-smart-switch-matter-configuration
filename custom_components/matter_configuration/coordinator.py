from __future__ import annotations

import asyncio
import logging
from contextlib import AsyncExitStack
from datetime import timedelta

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from matter_server.client.client import MatterClient

from .const import (
    ATTR_CH1_HOLD_ENABLED,
    ATTR_CH1_MAX_TAPS,
    ATTR_CH2_HOLD_ENABLED,
    ATTR_CH2_MAX_TAPS,
    ATTR_LONG_PRESS_MS,
    ATTR_MULTI_GAP_MS,
    ATTR_NUM_CHANNELS,
    ATTR_POLL_MS,
    BOOL_ATTRS,
    GESTURE_CONFIG_CLUSTER_ID,
)

_LOGGER = logging.getLogger(__name__)

ALL_ATTRS = (
    ATTR_NUM_CHANNELS,
    ATTR_POLL_MS,
    ATTR_LONG_PRESS_MS,
    ATTR_MULTI_GAP_MS,
    ATTR_CH1_MAX_TAPS,
    ATTR_CH1_HOLD_ENABLED,
    ATTR_CH2_MAX_TAPS,
    ATTR_CH2_HOLD_ENABLED,
)


class GestureConfigCoordinator(DataUpdateCoordinator[dict[int, int | bool]]):
    def __init__(self, hass: HomeAssistant, url: str, node_id: int, endpoint_id: int) -> None:
        super().__init__(hass, _LOGGER, name=f"matter_configuration_{node_id}", update_interval=timedelta(seconds=30))
        self.node_id = node_id
        self.endpoint_id = endpoint_id
        self._url = url
        self._client: MatterClient | None = None
        self._listen_task: asyncio.Task | None = None
        self._exit_stack = AsyncExitStack()

    def _attribute_path(self, attr_id: int) -> str:
        return f"{self.endpoint_id}/{GESTURE_CONFIG_CLUSTER_ID}/{attr_id}"

    async def _async_ensure_connected(self) -> MatterClient:
        if self._client is not None:
            return self._client

        session = async_get_clientsession(self.hass)
        client = await self._exit_stack.enter_async_context(MatterClient(self._url, session))

        ready = asyncio.Event()
        self._listen_task = asyncio.create_task(client.start_listening(ready))
        await ready.wait()

        self._client = client
        return client

    async def _async_update_data(self) -> dict[int, int | bool]:
        try:
            client = await self._async_ensure_connected()
            values: dict[int, int | bool] = {}
            for attr_id in ALL_ATTRS:
                path = self._attribute_path(attr_id)
                result = await client.read_attribute(self.node_id, path)
                value = result[path]
                if not isinstance(value, (int, bool)):
                    raise UpdateFailed(
                        f"Attribute {path} did not return a plain value ({value!r}) - the Gesture "
                        "Config cluster likely doesn't exist on this device's firmware yet"
                    )
                values[attr_id] = bool(value) if attr_id in BOOL_ATTRS else int(value)
            return values
        except Exception as err:
            raise UpdateFailed(f"Failed reading gesture config from node {self.node_id}: {err}") from err

    async def async_write_attribute(self, attr_id: int, value: int | bool) -> None:
        client = await self._async_ensure_connected()
        await client.write_attribute(self.node_id, self._attribute_path(attr_id), value)
        self.data[attr_id] = value
        self.async_update_listeners()

    async def async_close(self) -> None:
        if self._listen_task is not None:
            self._listen_task.cancel()
        await self._exit_stack.aclose()
