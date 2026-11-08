# Smart Switch Config

Requires the official Matter Server app, with your switch already paired to Home Assistant.

Open this app's web UI (or **Switch Config** in the sidebar, if you enable it on the Info tab), choose a switch
and press **Add switch**. The app joins the switch as a second Matter controller, which can take up to 2
minutes. Your existing Home Assistant pairing and automations are not affected.

Then change the gesture settings and press **Save**.

If adding a switch fails because it can't be found, set `network_interface` in the Configuration tab to your
network interface, for example `enp0s3` or `eth0`.
