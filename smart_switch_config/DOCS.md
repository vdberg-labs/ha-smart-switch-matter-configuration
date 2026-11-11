# Smart Switch Config

Requires the official Matter Server app, with your switch already paired to Home Assistant.

Open this app's web UI (or **Switch Config** in the sidebar, if you enable it on the Info tab), choose a switch
and press **Add switch**. The app joins the switch as a second Matter controller, which can take up to 2
minutes. Your existing Home Assistant pairing and automations are not affected.

Then change the gesture settings and press **Save**.

If adding a switch fails because it can't be found, set `network_interface` in the Configuration tab to your
network interface, for example `enp0s3` or `eth0`.

## Firmware updates

Upload a `matter.ota` file in the **Firmware** card. Each switch that can use it shows an **Update to …** button.
The switch downloads the update over Thread, which can take several minutes, then restarts. It keeps the new
firmware only if it still works a minute after restarting; otherwise it returns to the old version by itself.

The switch must be able to reach Home Assistant over the network to download the update.
