from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo, EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import ATTR_CH1_HOLD_ENABLED, ATTR_CH2_HOLD_ENABLED, DOMAIN
from .coordinator import GestureConfigCoordinator

# (attr_id, name)
SWITCH_DESCRIPTIONS = (
    (ATTR_CH1_HOLD_ENABLED, "Channel 1 hold enabled"),
    (ATTR_CH2_HOLD_ENABLED, "Channel 2 hold enabled"),
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: GestureConfigCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        GestureConfigSwitch(coordinator, entry, attr_id, name) for attr_id, name in SWITCH_DESCRIPTIONS
    )


class GestureConfigSwitch(CoordinatorEntity[GestureConfigCoordinator], SwitchEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_has_entity_name = True

    def __init__(self, coordinator: GestureConfigCoordinator, entry: ConfigEntry, attr_id: int, name: str) -> None:
        super().__init__(coordinator)
        self._attr_id = attr_id
        self._attr_name = name
        self._attr_unique_id = f"{entry.entry_id}_{attr_id}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{coordinator.node_id}_{coordinator.endpoint_id}")},
            name=f"Smart Switch gesture config (node {coordinator.node_id})",
            manufacturer="vdBerg Labs",
        )

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.data.get(self._attr_id)

    async def async_turn_on(self, **kwargs) -> None:
        await self.coordinator.async_write_attribute(self._attr_id, True)

    async def async_turn_off(self, **kwargs) -> None:
        await self.coordinator.async_write_attribute(self._attr_id, False)
