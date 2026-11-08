from __future__ import annotations

import logging

import aiohttp

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryError
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_ADDON_URL, CONF_DEVICE_ID, CONF_ENDPOINT_ID, CONF_NODE_ID, DOMAIN
from .coordinator import GestureConfigCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["number", "switch"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if CONF_DEVICE_ID not in entry.data:
        raise ConfigEntryError("This entry predates the Smart Switch Config app. Remove it and add it again.")

    coordinator = GestureConfigCoordinator(
        hass,
        entry.data[CONF_ADDON_URL],
        entry.data[CONF_DEVICE_ID],
        entry.data[CONF_NODE_ID],
        entry.data[CONF_ENDPOINT_ID],
    )
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    if CONF_DEVICE_ID not in entry.data:
        return
    url = f"{entry.data[CONF_ADDON_URL].rstrip('/')}/devices/{entry.data[CONF_DEVICE_ID]}"
    try:
        async with async_get_clientsession(hass).delete(url, timeout=aiohttp.ClientTimeout(total=30)) as response:
            if response.status != 200:
                _LOGGER.warning("App could not remove device %s: HTTP %s", entry.data[CONF_DEVICE_ID], response.status)
    except (aiohttp.ClientError, TimeoutError) as err:
        _LOGGER.warning("Could not reach the app to remove device %s: %s", entry.data[CONF_DEVICE_ID], err)
