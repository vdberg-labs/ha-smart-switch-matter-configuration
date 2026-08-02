from __future__ import annotations

from homeassistant.components.number import NumberEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo, EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    ATTR_CH1_MAX_TAPS,
    ATTR_CH2_MAX_TAPS,
    ATTR_LONG_PRESS_MS,
    ATTR_MULTI_GAP_MS,
    ATTR_NUM_CHANNELS,
    ATTR_POLL_MS,
    DOMAIN,
    MAX_LONG_PRESS_MS,
    MAX_MAX_TAPS,
    MAX_MULTI_GAP_MS,
    MAX_NUM_CHANNELS,
    MAX_POLL_MS,
    MIN_LONG_PRESS_MS,
    MIN_MAX_TAPS,
    MIN_MULTI_GAP_MS,
    MIN_NUM_CHANNELS,
    MIN_POLL_MS,
)
from .coordinator import GestureConfigCoordinator

# (attr_id, name, min, max, step, unit)
NUMBER_DESCRIPTIONS = (
    (ATTR_NUM_CHANNELS, "Channels", MIN_NUM_CHANNELS, MAX_NUM_CHANNELS, 1, None),
    (ATTR_POLL_MS, "Poll interval", MIN_POLL_MS, MAX_POLL_MS, 1, "ms"),
    (ATTR_LONG_PRESS_MS, "Long press threshold", MIN_LONG_PRESS_MS, MAX_LONG_PRESS_MS, 10, "ms"),
    (ATTR_MULTI_GAP_MS, "Multi-tap gap", MIN_MULTI_GAP_MS, MAX_MULTI_GAP_MS, 10, "ms"),
    (ATTR_CH1_MAX_TAPS, "Channel 1 max taps", MIN_MAX_TAPS, MAX_MAX_TAPS, 1, None),
    (ATTR_CH2_MAX_TAPS, "Channel 2 max taps", MIN_MAX_TAPS, MAX_MAX_TAPS, 1, None),
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: GestureConfigCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        GestureConfigNumber(coordinator, entry, attr_id, name, min_v, max_v, step, unit)
        for attr_id, name, min_v, max_v, step, unit in NUMBER_DESCRIPTIONS
    )


class GestureConfigNumber(CoordinatorEntity[GestureConfigCoordinator], NumberEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: GestureConfigCoordinator,
        entry: ConfigEntry,
        attr_id: int,
        name: str,
        min_value: float,
        max_value: float,
        step: float,
        unit: str | None,
    ) -> None:
        super().__init__(coordinator)
        self._attr_id = attr_id
        self._attr_name = name
        self._attr_native_min_value = min_value
        self._attr_native_max_value = max_value
        self._attr_native_step = step
        self._attr_native_unit_of_measurement = unit
        self._attr_unique_id = f"{entry.entry_id}_{attr_id}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{coordinator.node_id}_{coordinator.endpoint_id}")},
            name=f"Smart Switch gesture config (node {coordinator.node_id})",
            manufacturer="vdBerg Labs",
        )

    @property
    def native_value(self) -> float | None:
        return self.coordinator.data.get(self._attr_id)

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.async_write_attribute(self._attr_id, int(value))
