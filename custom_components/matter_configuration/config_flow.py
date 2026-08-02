from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries

from .const import (
    CONF_ENDPOINT_ID,
    CONF_MATTER_WS_URL,
    CONF_NODE_ID,
    DEFAULT_ENDPOINT_ID,
    DEFAULT_MATTER_WS_URL,
    DOMAIN,
)

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_NODE_ID): vol.Coerce(int),
        vol.Optional(CONF_ENDPOINT_ID, default=DEFAULT_ENDPOINT_ID): vol.Coerce(int),
        vol.Optional(CONF_MATTER_WS_URL, default=DEFAULT_MATTER_WS_URL): str,
    }
)


class MatterConfigurationConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict | None = None):
        if user_input is not None:
            await self.async_set_unique_id(f"{user_input[CONF_NODE_ID]}-{user_input[CONF_ENDPOINT_ID]}")
            self._abort_if_unique_id_configured()
            return self.async_create_entry(
                title=f"Gesture config (node {user_input[CONF_NODE_ID]})",
                data=user_input,
            )

        return self.async_show_form(step_id="user", data_schema=STEP_USER_SCHEMA)
