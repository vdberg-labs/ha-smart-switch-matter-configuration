DOMAIN = "matter_configuration"

CONF_NODE_ID = "node_id"
CONF_ENDPOINT_ID = "endpoint_id"
CONF_MATTER_WS_URL = "matter_ws_url"

DEFAULT_MATTER_WS_URL = "ws://core-matter-server:5580/ws"
DEFAULT_ENDPOINT_ID = 3

# Test/dev vendor ID this firmware's Matter build uses (NCS/CHIP SDK sample
# default) - confirm against the device's actual factory data if this ever
# changes. Matches protocol/matter/src/app/default_zap/GestureConfigCluster.xml.
VENDOR_ID = 0xFFF1
GESTURE_CONFIG_CLUSTER_SUFFIX = 0xFC01
GESTURE_CONFIG_CLUSTER_ID = (VENDOR_ID << 16) | GESTURE_CONFIG_CLUSTER_SUFFIX

# Attribute IDs use Matter's manufacturer-specific MEI suffix convention
# (vendor_id<<16 | small suffix, same pattern as Nordic's own manufacturer_specific
# sample), not Zigbee's plain 0-7 - see GestureConfigCluster.xml for the source
# of truth. Same field order/meaning as the Zigbee 0xFC01 cluster otherwise.
_ATTR_BASE = VENDOR_ID << 16
ATTR_NUM_CHANNELS = _ATTR_BASE | 0x0000
ATTR_POLL_MS = _ATTR_BASE | 0x0001
ATTR_LONG_PRESS_MS = _ATTR_BASE | 0x0002
ATTR_MULTI_GAP_MS = _ATTR_BASE | 0x0003
ATTR_CH1_MAX_TAPS = _ATTR_BASE | 0x0004
ATTR_CH1_HOLD_ENABLED = _ATTR_BASE | 0x0005
ATTR_CH2_MAX_TAPS = _ATTR_BASE | 0x0006
ATTR_CH2_HOLD_ENABLED = _ATTR_BASE | 0x0007

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
