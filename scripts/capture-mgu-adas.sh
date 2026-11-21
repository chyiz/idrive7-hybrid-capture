#!/bin/sh
# ============================================================================
# capture-mgu-adas.sh - Capture outbound SOME/IP NavGraph2 (0xb51d) and
# KombiIF (0xb51b) traffic on a rooted BMW MGU (iDrive 7) head unit.
#
# Why this complements the Hybrid Capture OAP app:
#   The OAP app captures all *inbound* VEM/FES/Efficiencytainment/Powertrain/
#   Nav telemetry into /tmp/hybrid-capture-latest.jsonl without needing SSH.
#   However, outbound MGU -> BDC gateway setters on 0xb51d (navigation.ADAS /
#   NavGraph2) and 0xb51b (KombiIF.routeDestinationElectricHybrid) have
#   getter.id=0 and no notifier, so observing BMW native Nav's exact outbound
#   bytes requires sniffing SOME/IP traffic as root on the MGU.
#
# Usage (from your Mac over ENET SSH):
#   ssh -i <key> root@169.254.123.42 'sh -s' < scripts/capture-mgu-adas.sh
#
# Or copy onto the MGU and run directly:
#   sh capture-mgu-adas.sh [duration_sec] [out_pcap]
# ============================================================================
set -eu

DUR="${1:-120}"
OUT="${2:-/tmp/adas-vem-capture.pcap}"

echo "[adas-capture] Checking network interfaces & vsomeip sockets..."
ip -br addr 2>/dev/null || ifconfig -a 2>/dev/null | head -n 40

if ! command -v tcpdump >/dev/null 2>&1; then
    echo "[adas-capture] tcpdump not installed on this MGU." >&2
    echo "[adas-capture] Check if vsomeip/DLT tracing is available (dlt-receive or /etc/vsomeip*)." >&2
    ls -la /etc/vsomeip* /var/opt/public/oap/oap_*/someipInterfaces/ 2>/dev/null || true
    exit 1
fi

# SOME/IP over UDP/TCP typically uses ports 30490..31000 (service discovery 30490,
# BDC<->MGU gateway ports in 30500..30999). Capture the SOME/IP payload header:
# bytes [8:10] of UDP payload = SOME/IP Service ID (0xb51d ADAS, 0xb51b KombiIF,
# 0xb517 Efficiencytainment2, 0xb50d FES, 0xb54d ConnectedForesight).
# Filter UDP packets matching those service IDs in the first 2 bytes of UDP payload:
#   udp[8:2] == 0xb51d  (navigation.ADAS / NavGraph2)
#   udp[8:2] == 0xb51b  (KombiIF / routeDestinationElectricHybrid)
#   udp[8:2] == 0xb517  (Efficiencytainment2 / VEM & SOC Hold)
#   udp[8:2] == 0xb50d  (FES / Drive Strategy)
#   udp[8:2] == 0xb54d  (ConnectedForesight / EDriveZones)
#   udp port 30490      (SOME/IP-SD offers & subscriptions)
BPF="udp port 30490 or (udp and (udp[8:2] = 0xb51d or udp[8:2] = 0xb51b or udp[8:2] = 0xb517 or udp[8:2] = 0xb50d or udp[8:2] = 0xb54d))"

echo "[adas-capture] Capturing for ${DUR}s -> ${OUT}"
echo "[adas-capture] Filter: ${BPF}"
echo "[adas-capture] While running: drive/idle with NO BMW Nav, then enter a far BMW Nav destination."

if command -v timeout >/dev/null 2>&1; then
    timeout "${DUR}" tcpdump -i any -s 0 -w "${OUT}" "${BPF}" || true
else
    tcpdump -i any -s 0 -w "${OUT}" "${BPF}" &
    PID=$!
    sleep "${DUR}"
    kill -INT "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
fi

chmod 0644 "${OUT}" 2>/dev/null || true
ls -lh "${OUT}"
echo "[adas-capture] Done! Pull both files from your Mac:"
echo "  scp root@169.254.123.42:/tmp/hybrid-capture-latest.jsonl ."
echo "  scp root@169.254.123.42:${OUT} ."
