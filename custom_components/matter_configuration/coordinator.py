from __future__ import annotations

import logging
from datetime import timedelta

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import BOOL_ATTRS

_LOGGER = logging.getLogger(__name__)

REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=30)


class GestureConfigCoordinator(DataUpdateCoordinator[dict[int, int | bool]]):
    def __init__(self, hass: HomeAssistant, addon_url: str, device_id: str, node_id: int, endpoint_id: int) -> None:
        super().__init__(hass, _LOGGER, name=f"matter_configuration_{node_id}", update_interval=timedelta(seconds=30))
        self.node_id = node_id
        self.endpoint_id = endpoint_id
        self._device_url = f"{addon_url.rstrip('/')}/devices/{device_id}"
        self._session = async_get_clientsession(hass)

    async def _async_update_data(self) -> dict[int, int | bool]:
        try:
            async with self._session.get(
                f"{self._device_url}/config",
                params={"endpoint": self.endpoint_id},
                timeout=REQUEST_TIMEOUT,
            ) as response:
                body = await response.json()
                if response.status != 200:
                    raise UpdateFailed(body.get("error", f"HTTP {response.status}"))
        except (aiohttp.ClientError, TimeoutError) as err:
            raise UpdateFailed(f"Failed reading gesture config from node {self.node_id}: {err}") from err

        return {
            int(attr_id): bool(value) if int(attr_id) in BOOL_ATTRS else int(value)
            for attr_id, value in body.items()
        }

    async def async_write_attribute(self, attr_id: int, value: int | bool) -> None:
        try:
            async with self._session.put(
                f"{self._device_url}/attributes/{attr_id}",
                json={"endpoint": self.endpoint_id, "value": value},
                timeout=REQUEST_TIMEOUT,
            ) as response:
                if response.status != 200:
                    body = await response.json()
                    raise HomeAssistantError(body.get("error", f"HTTP {response.status}"))
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HomeAssistantError(f"Failed writing gesture config to node {self.node_id}: {err}") from err

        self.data[attr_id] = value
        self.async_update_listeners()
