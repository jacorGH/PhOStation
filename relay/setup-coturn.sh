#!/usr/bin/env bash
# PhoStation: install your own TURN relay (coturn) on a fresh Ubuntu 22.04/24.04 server.
# Works on free cloud servers such as Oracle Cloud "Always Free".
#
#   curl -fsSL <raw link to this file> -o setup-coturn.sh
#   sudo bash setup-coturn.sh https://yourname.github.io/phostation/
#
# The argument is your PhoStation address; the script prints a link that saves the relay
# in the app when you open it on your phone.
set -euo pipefail

APP_URL="${1:-}"
TURN_USER="phostation"
TURN_PASS="$(openssl rand -hex 16)"
PORT=3478
MIN_PORT=49160
MAX_PORT=49360

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi

echo "== Finding this server's addresses"
PUBLIC_IP="$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me)"
PRIVATE_IP="$(hostname -I | awk '{print $1}')"
echo "   public  $PUBLIC_IP"
echo "   private $PRIVATE_IP"

echo "== Installing coturn"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y coturn iptables-persistent

echo "== Writing /etc/turnserver.conf"
cat > /etc/turnserver.conf <<CONF
# PhoStation relay
listening-port=${PORT}
listening-ip=${PRIVATE_IP}
relay-ip=${PRIVATE_IP}
external-ip=${PUBLIC_IP}/${PRIVATE_IP}
min-port=${MIN_PORT}
max-port=${MAX_PORT}
realm=phostation
fingerprint
lt-cred-mech
user=${TURN_USER}:${TURN_PASS}
# Limits so a leaked login can't run up your bandwidth
total-quota=12
user-quota=8
max-bps=6000000
stale-nonce=600
no-cli
no-multicast-peers
no-tlsv1
no-tlsv1_1
# Never relay into private networks
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
log-file=/var/log/turnserver.log
simple-log
CONF
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || echo "TURNSERVER_ENABLED=1" > /etc/default/coturn

echo "== Opening the firewall on this server"
iptables -I INPUT -p udp --dport ${PORT} -j ACCEPT
iptables -I INPUT -p tcp --dport ${PORT} -j ACCEPT
iptables -I INPUT -p udp --dport ${MIN_PORT}:${MAX_PORT} -j ACCEPT
netfilter-persistent save >/dev/null 2>&1 || true
if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow ${PORT}/udp; ufw allow ${PORT}/tcp; ufw allow ${MIN_PORT}:${MAX_PORT}/udp
fi

echo "== Starting the relay"
systemctl enable coturn >/dev/null
systemctl restart coturn
sleep 1
systemctl is-active --quiet coturn && echo "   coturn is running" || { echo "coturn failed to start; see: journalctl -u coturn" >&2; exit 1; }

URLS="turn:${PUBLIC_IP}:${PORT}?transport=udp,turn:${PUBLIC_IP}:${PORT}?transport=tcp"
JSON="{\"url\":\"${URLS}\",\"user\":\"${TURN_USER}\",\"pass\":\"${TURN_PASS}\"}"
B64="$(printf '%s' "$JSON" | base64 -w0 | tr '+/' '-_' | tr -d '=')"

cat <<DONE

==================================================================
 Your relay is ready.

 IMPORTANT: also open these ports in your cloud provider's firewall
 (Oracle: Networking > Virtual cloud networks > your VCN > Security
 Lists > Default > Add Ingress Rules, source 0.0.0.0/0):
   UDP ${PORT}, TCP ${PORT}, UDP ${MIN_PORT}-${MAX_PORT}

 PhoStation settings (Settings > Your relay > Own server):
   TURN URL : ${URLS}
   Username : ${TURN_USER}
   Password : ${TURN_PASS}
DONE
if [ -n "$APP_URL" ]; then
  echo ""
  echo " Or open this link on your phone to save it automatically:"
  echo "   ${APP_URL%/}/?turn=${B64}"
fi
echo "=================================================================="
