from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_ENDPOINT_ID, CONF_MATTER_WS_URL, CONF_NODE_ID, DOMAIN
from .coordinator import GestureConfigCoordinator

PLATFORMS = ["number", "switch"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = GestureConfigCoordinator(
        hass,
        entry.data[CONF_MATTER_WS_URL],
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
        coordinator: GestureConfigCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_close()
    return unloaded
