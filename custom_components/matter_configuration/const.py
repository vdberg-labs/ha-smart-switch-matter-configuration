DOMAIN = "matter_configuration"

CONF_NODE_ID = "node_id"
CONF_ENDPOINT_ID = "endpoint_id"
CONF_MATTER_WS_URL = "matter_ws_url"

DEFAULT_MATTER_WS_URL = "ws://homeassistant.local:5580/ws"
DEFAULT_ENDPOINT_ID = 3

# Test/dev vendor ID this firmware's Matter build currently uses (NCS/CHIP SDK
# sample default) - confirm against the device's actual factory data if this
# ever changes.
VENDOR_ID = 0xFFF1
GESTURE_CONFIG_CLUSTER_SUFFIX = 0xFC01
GESTURE_CONFIG_CLUSTER_ID = (VENDOR_ID << 16) | GESTURE_CONFIG_CLUSTER_SUFFIX

# Attribute IDs mirror protocol/zigbee/src/zigbee/zb_gesture_config_cluster.h
# exactly, so the same layout can be reused if/when the Matter firmware grows
# a matching cluster.
ATTR_NUM_CHANNELS = 0
ATTR_POLL_MS = 1
ATTR_LONG_PRESS_MS = 2
ATTR_MULTI_GAP_MS = 3
ATTR_CH1_MAX_TAPS = 4
ATTR_CH1_HOLD_ENABLED = 5
ATTR_CH2_MAX_TAPS = 6
ATTR_CH2_HOLD_ENABLED = 7

BOOL_ATTRS = (ATTR_CH1_HOLD_ENABLED, ATTR_CH2_HOLD_ENABLED)

# Ranges mirror shared/config/gesture_config.h.
MIN_NUM_CHANNELS = 1
MAX_NUM_CHANNELS = 2
MIN_MAX_TAPS = 1
MAX_MAX_TAPS = 5
MIN_POLL_MS = 1
MAX_POLL_MS = 50
MIN_LONG_PRESS_MS = 200
MAX_LONG_PRESS_MS = 5000
MIN_MULTI_GAP_MS = 50
MAX_MULTI_GAP_MS = 2000
