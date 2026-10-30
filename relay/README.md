# Your own relay (TURN)

Most of the time PhoStation connects players directly. When two networks can't reach each other (the connection check says **Strict** or **Blocked**), a TURN relay carries the game instead. Only the host needs one: with **Share my relay with friends I invite** on, invites carry short-lived relay logins (valid up to a day) so friends can use it too.

Pick one option.

## Option A: Cloudflare (free, easiest)

Cloudflare's TURN relay is free for the first 1,000 GB each month. A PS1 stream uses roughly 0.5 to 1.5 GB an hour per friend, and only when a direct connection fails, so this is effectively free for gaming. A tiny Worker (free plan: 100,000 requests a day) keeps your Cloudflare key secret and gives PhoStation short-lived logins. All of this can be done from a phone.

1. Create a free account at dash.cloudflare.com.
2. In the dashboard, open **Realtime**, then **TURN Server**, and create a TURN key. Copy the **Turn Token ID** and the **API Token**. The API token is only shown once.
3. Open **Workers & Pages**, create a Worker from the **Hello World** template, name it something like `phostation-relay`, and deploy it.
4. Choose **Edit code**, replace everything with the contents of `cloudflare-worker.js`, and deploy again.
5. In the Worker's **Settings > Variables and Secrets**, add:
   - `TURN_KEY_ID`: the Turn Token ID
   - `TURN_KEY_API_TOKEN`: the API token (type: Secret)
   - `ACCESS_CODE`: any password you make up (type: Secret)
   - optional `ALLOWED_ORIGIN`: your PhoStation site, e.g. `https://yourname.github.io`
6. In PhoStation: **Settings > Your relay > Cloudflare**, paste the Worker address (ends in `workers.dev`) and your access code, then tap **Save and test**.

Dashboard menu names change from time to time. If you can't find TURN, search the dashboard for "TURN".

## Option B: your own server

For a relay that runs entirely on your own machine, use `setup-coturn.sh` on a fresh Ubuntu 22.04 or 24.04 server. Oracle Cloud's **Always Free** tier includes small servers with 10 TB of outbound traffic a month; it asks for a card to verify identity but doesn't charge for Always Free resources.

1. Create the server and connect to it over SSH.
2. Run:
   ```
   curl -fsSL <raw GitHub link to relay/setup-coturn.sh> -o setup-coturn.sh
   sudo bash setup-coturn.sh https://yourname.github.io/phostation/
   ```
3. Open the ports it lists in your cloud provider's firewall (on Oracle: your VCN's **Security List**, ingress rules from `0.0.0.0/0`): UDP 3478, TCP 3478 and UDP 49160-49360.
4. Open the link it prints on your phone. The relay is saved in PhoStation. Or enter the URL, username and password by hand under **Settings > Your relay > Own server**.

The script blocks relaying into private networks and caps sessions and bandwidth, so a leaked password can't be used to reach other machines or run up big bills.

## Checking it

**Settings > Check my connection** tests the relay along with your network. During play, the stats show **Relay** next to anyone whose connection went through it.
